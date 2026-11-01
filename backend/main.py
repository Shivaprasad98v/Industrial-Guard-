
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import database
from .mqtt_client import start_mqtt


# --------------------------------------------------
# APPLICATION CONFIGURATION
# --------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / ".env")

app = FastAPI(
    title="IndustrialGuard AI API",
    version="2.1.0",
    description="Industrial IoT monitoring and predictive maintenance API"
)


# --------------------------------------------------
# GLOBAL STATE
# --------------------------------------------------

clients: set[WebSocket] = set()

latest: dict[str, dict[str, Any]] = {}

mqtt_client = None

mqtt_error = "MQTT not configured or unavailable"

pending_broadcasts: list[dict] = []

event_loop = None


# --------------------------------------------------
# TELEMETRY DATA MODEL
# --------------------------------------------------

class Telemetry(BaseModel):

    machine_id: str = Field(
        default="Machine 01",
        max_length=80
    )

    timestamp: str = Field(
        default_factory=lambda:
        datetime.now(timezone.utc).isoformat()
    )

    sequence: int | None = None

    mpu6050: dict[str, Any] | None = None
    sw420: dict[str, Any] | None = None
    dht22: dict[str, Any] | None = None
    a3144: dict[str, Any] | None = None
    mq2: dict[str, Any] | None = None
    mc38: dict[str, Any] | None = None

    outputs: dict[str, Any] | None = None

    sensor_status: dict[str, str] = Field(
        default_factory=dict
    )

    vibration_rms: float | None = None
    rpm: float | None = None

    ambient_temperature: float | None = None
    humidity: float | None = None

    gas_sensor_raw: float | None = None

    enclosure_closed: bool | None = None

    events: list[dict[str, Any]] = Field(
        default_factory=list
    )

    fft: dict[str, Any] | None = None


# --------------------------------------------------
# ALARM ACKNOWLEDGEMENT MODEL
# --------------------------------------------------

class AlarmAck(BaseModel):
    acknowledged: bool = True


# --------------------------------------------------
# WEBSOCKET BROADCAST
# --------------------------------------------------

async def broadcast(message: dict):

    dead = []

    for ws in list(clients):

        try:
            await ws.send_json(message)

        except Exception:
            dead.append(ws)

    for ws in dead:
        clients.discard(ws)


def queue_broadcast(message: dict):

    """
    Safely schedule broadcasts from MQTT's background
    network thread into the FastAPI event loop.
    """

    if event_loop is not None and event_loop.is_running():

        event_loop.call_soon_threadsafe(
            pending_broadcasts.append,
            message
        )


# --------------------------------------------------
# TELEMETRY NORMALIZATION
# --------------------------------------------------

def normalize_payload(raw: dict) -> dict:

    data = Telemetry.model_validate(raw).model_dump()

    # DHT22 backward compatibility

    if (
        data.get("dht22") is None
        and (
            data.get("ambient_temperature") is not None
            or data.get("humidity") is not None
        )
    ):

        data["dht22"] = {
            "temperature_c": data.get("ambient_temperature"),
            "humidity_pct": data.get("humidity")
        }

    # A3144 RPM compatibility

    if data.get("a3144") is None and data.get("rpm") is not None:

        data["a3144"] = {
            "rpm": data["rpm"]
        }

    # MQ2 compatibility

    if data.get("mq2") is None and data.get("gas_sensor_raw") is not None:

        data["mq2"] = {
            "raw_adc": data["gas_sensor_raw"],
            "enabled": True
        }

    # MC38 compatibility

    if data.get("mc38") is None and data.get("enclosure_closed") is not None:

        data["mc38"] = {
            "closed": data["enclosure_closed"]
        }

    # MPU6050 vibration extraction

    if data.get("mpu6050"):

        axes = data["mpu6050"]

        if data.get("vibration_rms") is None:

            data["vibration_rms"] = axes.get(
                "vibration_rms_g"
            )

    # DHT22 temperature and humidity extraction
    # Supports both naming conventions.

    if data.get("dht22"):

        dht = data["dht22"]

        data["ambient_temperature"] = dht.get(
            "temperature_c",
            dht.get(
                "temperature",
                data.get("ambient_temperature")
            )
        )

        data["humidity"] = dht.get(
            "humidity_pct",
            dht.get(
                "humidity",
                data.get("humidity")
            )
        )

    # A3144 RPM extraction

    if data.get("a3144"):

        data["rpm"] = data["a3144"].get(
            "rpm",
            data.get("rpm")
        )

    # MQ2 gas sensor extraction

    if data.get("mq2"):

        data["gas_sensor_raw"] = data["mq2"].get(
            "raw_adc",
            data.get("gas_sensor_raw")
        )

    # MC38 enclosure extraction

    if data.get("mc38"):

        data["enclosure_closed"] = data["mc38"].get(
            "closed",
            data.get("enclosure_closed")
        )

    return data


# --------------------------------------------------
# ALARM DETECTION
# --------------------------------------------------

def condition_alarms(d: dict):

    alarms = []

    # Vibration alarm

    vibration = d.get("vibration_rms")

    if vibration is not None and vibration >= 1.2:

        alarms.append({

            "timestamp": d["timestamp"],

            "machine_id": d["machine_id"],

            "parameter": "Vibration RMS",

            "value": f"{vibration:.2f} g",

            "severity": (
                "Critical"
                if vibration >= 1.8
                else "Warning"
            ),

            "description":
            "Vibration exceeded configured demonstration threshold"

        })

    # Temperature alarm

    temperature = d.get("ambient_temperature")

    if temperature is not None and temperature >= 45:

        alarms.append({

            "timestamp": d["timestamp"],

            "machine_id": d["machine_id"],

            "parameter": "Ambient temperature",

            "value": f"{temperature:.1f} °C",

            "severity": (
                "Critical"
                if temperature >= 55
                else "Warning"
            ),

            "description":
            "Ambient temperature exceeded configured demonstration threshold"

        })

    # Enclosure alarm

    if d.get("enclosure_closed") is False:

        alarms.append({

            "timestamp": d["timestamp"],

            "machine_id": d["machine_id"],

            "parameter": "Enclosure",

            "value": "Open",

            "severity": "Warning",

            "description":
            "MC-38 reports enclosure open"

        })

    # Sensor event alarms

    for event in d.get("events") or []:

        alarms.append({

            "timestamp": event.get(
                "timestamp",
                d["timestamp"]
            ),

            "machine_id": d["machine_id"],

            "parameter": str(
                event.get("sensor", "Sensor event")
            ),

            "value": str(
                event.get("value", "Detected")
            ),

            "severity": str(
                event.get("severity", "Warning")
            ),

            "description": str(
                event.get(
                    "message",
                    "Sensor event detected"
                )
            )

        })

    return alarms


# --------------------------------------------------
# PROCESS TELEMETRY
# --------------------------------------------------

def process_telemetry(raw: dict):

    try:

        data = normalize_payload(raw)

        machine_id = data["machine_id"]

        # Update latest machine data

        latest[machine_id] = data

        # Save telemetry to database

        database.save_telemetry(data)

        # Generate alarms

        alarms = condition_alarms(data)

        for alarm in alarms:

            alarm["id"] = database.save_alarm(alarm)

            queue_broadcast({

                "type": "alarm",

                "data": alarm

            })

        # Broadcast telemetry

        queue_broadcast({

            "type": "telemetry",

            "data": data

        })

        print(
            f"Telemetry processed successfully: {machine_id}"
        )

    except Exception as exc:

        print(
            f"Telemetry processing error: {exc}"
        )


# --------------------------------------------------
# APPLICATION STARTUP
# --------------------------------------------------

@app.on_event("startup")
async def startup():

    global mqtt_client
    global mqtt_error
    global event_loop

    event_loop = asyncio.get_running_loop()

    print("Starting IndustrialGuard AI backend...")

    # Initialize database

    database.init_db()

    print("Database initialized successfully")

    # Start MQTT connection

    mqtt_client, err = start_mqtt(process_telemetry)

    mqtt_error = err or ""

    if mqtt_client:

        print("MQTT client initialization completed")

    else:

        print(
            f"MQTT client unavailable: {mqtt_error}"
        )

    # Background WebSocket broadcaster

    async def broadcaster():

        while True:

            await asyncio.sleep(0.1)

            while pending_broadcasts:

                message = pending_broadcasts.pop(0)

                await broadcast(message)

    asyncio.create_task(broadcaster())

    print("IndustrialGuard AI startup completed")


# --------------------------------------------------
# APPLICATION SHUTDOWN
# --------------------------------------------------

@app.on_event("shutdown")
async def shutdown():

    global mqtt_client

    print("Shutting down IndustrialGuard AI...")

    if mqtt_client:

        mqtt_client.disconnect()

        mqtt_client.loop_stop()

        print("MQTT connection stopped")

    print("IndustrialGuard AI stopped")


# --------------------------------------------------
# FRONTEND
# --------------------------------------------------

@app.get("/")
async def index():

    return FileResponse(
        BASE_DIR / "frontend" / "index.html"
    )


app.mount(

    "/static",

    StaticFiles(
        directory=BASE_DIR / "frontend"
    ),

    name="static"

)


# --------------------------------------------------
# HEALTH CHECK
# --------------------------------------------------

@app.get("/api/health")
async def health():

    connected = bool(
        mqtt_client and mqtt_client.is_connected()
    )

    return {

        "ok": True,

        "mqtt_connected": connected,

        "mqtt_error": mqtt_error,

        "mode": "hardware"

    }


# --------------------------------------------------
# MACHINES API
# --------------------------------------------------

@app.get("/api/machines")
async def machines():

    return [

        {

            "machine_id": machine_id,

            "last_seen": data["timestamp"]

        }

        for machine_id, data in latest.items()

    ]


# --------------------------------------------------
# LATEST TELEMETRY API
# --------------------------------------------------

@app.get("/api/telemetry/latest")
async def telemetry_latest():

    if latest:

        return list(latest.values())

    history = database.get_telemetry(1)

    return history[-1:] if history else []


# --------------------------------------------------
# TELEMETRY HISTORY API
# --------------------------------------------------

@app.get("/api/telemetry/history")
async def telemetry_history(limit: int = 300):

    limit = max(1, min(limit, 2000))

    return database.get_telemetry(limit)


# --------------------------------------------------
# ALARMS API
# --------------------------------------------------

@app.get("/api/alarms")
async def alarms():

    return database.get_alarms()


# --------------------------------------------------
# ACKNOWLEDGE ALARM API
# --------------------------------------------------

@app.post("/api/alarms/{alarm_id}/acknowledge")
async def acknowledge(alarm_id: int):

    if not database.acknowledge_alarm(alarm_id):

        raise HTTPException(

            status_code=404,

            detail="Alarm not found"

        )

    return {

        "ok": True,

        "alarm_id": alarm_id,

        "acknowledged": True

    }


# --------------------------------------------------
# HTTP TELEMETRY INGESTION
# --------------------------------------------------

@app.post("/api/telemetry")
async def ingest_telemetry(payload: Telemetry):

    data = payload.model_dump()

    process_telemetry(data)

    return {

        "ok": True,

        "received": data["machine_id"]

    }


# --------------------------------------------------
# WEBSOCKET TELEMETRY
# --------------------------------------------------

@app.websocket("/ws/telemetry")
async def websocket_endpoint(ws: WebSocket):

    await ws.accept()

    clients.add(ws)

    try:

        # Send current machine snapshot

        if latest:

            await ws.send_json({

                "type": "snapshot",

                "data": list(latest.values())

            })

        # Keep connection alive

        while True:

            await ws.receive_text()

    except WebSocketDisconnect:

        clients.discard(ws)

    except Exception as exc:

        print(
            f"WebSocket error: {exc}"
        )

        clients.discard(ws)
