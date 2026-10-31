import asyncio
import json
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

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
app = FastAPI(title="IndustrialGuard AI API", version="2.0.0")
clients: set[WebSocket] = set()
latest: dict[str, dict[str, Any]] = {}
mqtt_client = None
mqtt_error = "MQTT not configured or unavailable"
pending_broadcasts: list[dict] = []

class Telemetry(BaseModel):
    machine_id: str = Field(default="Machine 01", max_length=80)
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    sequence: int | None = None
    mpu6050: dict[str, Any] | None = None
    sw420: dict[str, Any] | None = None
    dht22: dict[str, Any] | None = None
    a3144: dict[str, Any] | None = None
    mq2: dict[str, Any] | None = None
    mc38: dict[str, Any] | None = None
    outputs: dict[str, Any] | None = None
    sensor_status: dict[str, str] = Field(default_factory=dict)
    vibration_rms: float | None = None
    rpm: float | None = None
    ambient_temperature: float | None = None
    humidity: float | None = None
    gas_sensor_raw: float | None = None
    enclosure_closed: bool | None = None
    events: list[dict[str, Any]] = Field(default_factory=list)
    fft: dict[str, Any] | None = None

class AlarmAck(BaseModel):
    acknowledged: bool = True

async def broadcast(message: dict):
    dead = []
    for ws in list(clients):
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)

def normalize_payload(raw: dict) -> dict:
    data = Telemetry.model_validate(raw).model_dump()
    # Backward compatibility with the original dashboard payload.
    if data.get("dht22") is None and (data.get("ambient_temperature") is not None or data.get("humidity") is not None):
        data["dht22"] = {"temperature_c": data.get("ambient_temperature"), "humidity_pct": data.get("humidity")}
    if data.get("a3144") is None and data.get("rpm") is not None:
        data["a3144"] = {"rpm": data["rpm"]}
    if data.get("mq2") is None and data.get("gas_sensor_raw") is not None:
        data["mq2"] = {"raw_adc": data["gas_sensor_raw"], "enabled": True}
    if data.get("mc38") is None and data.get("enclosure_closed") is not None:
        data["mc38"] = {"closed": data["enclosure_closed"]}
    if data.get("mpu6050"):
        axes = data["mpu6050"]
        if data.get("vibration_rms") is None:
            data["vibration_rms"] = axes.get("vibration_rms_g")
    if data.get("dht22"):
        data["ambient_temperature"] = data["dht22"].get("temperature_c", data.get("ambient_temperature"))
        data["humidity"] = data["dht22"].get("humidity_pct", data.get("humidity"))
    if data.get("a3144"):
        data["rpm"] = data["a3144"].get("rpm", data.get("rpm"))
    if data.get("mq2"):
        data["gas_sensor_raw"] = data["mq2"].get("raw_adc", data.get("gas_sensor_raw"))
    if data.get("mc38"):
        data["enclosure_closed"] = data["mc38"].get("closed", data.get("enclosure_closed"))
    return data

def condition_alarms(d: dict):
    alarms = []
    v = d.get("vibration_rms")
    if v is not None and v >= 1.2:
        alarms.append({"timestamp": d["timestamp"], "machine_id": d["machine_id"], "parameter": "Vibration RMS", "value": f"{v:.2f} g", "severity": "Critical" if v >= 1.8 else "Warning", "description": "Vibration exceeded configured demonstration threshold"})
    t = d.get("ambient_temperature")
    if t is not None and t >= 45:
        alarms.append({"timestamp": d["timestamp"], "machine_id": d["machine_id"], "parameter": "Ambient temperature", "value": f"{t:.1f} °C", "severity": "Critical" if t >= 55 else "Warning", "description": "Ambient temperature exceeded configured demonstration threshold"})
    if d.get("enclosure_closed") is False:
        alarms.append({"timestamp": d["timestamp"], "machine_id": d["machine_id"], "parameter": "Enclosure", "value": "Open", "severity": "Warning", "description": "MC-38 reports enclosure open"})
    for event in d.get("events") or []:
        alarms.append({"timestamp": event.get("timestamp", d["timestamp"]), "machine_id": d["machine_id"], "parameter": str(event.get("sensor", "Sensor event")), "value": str(event.get("value", "Detected")), "severity": str(event.get("severity", "Warning")), "description": str(event.get("message", "Sensor event detected"))})
    return alarms

def process_telemetry(raw: dict):
    data = normalize_payload(raw)
    latest[data["machine_id"]] = data
    database.save_telemetry(data)
    for alarm in condition_alarms(data):
        alarm["id"] = database.save_alarm(alarm)
        pending_broadcasts.append({"type": "alarm", "data": alarm})
    pending_broadcasts.append({"type": "telemetry", "data": data})

@app.on_event("startup")
async def startup():
    global mqtt_client, mqtt_error
    database.init_db()
    mqtt_client, err = start_mqtt(process_telemetry)
    mqtt_error = err or ""
    async def broadcaster():
        while True:
            await asyncio.sleep(0.1)
            while pending_broadcasts:
                await broadcast(pending_broadcasts.pop(0))
    asyncio.create_task(broadcaster())

@app.on_event("shutdown")
async def shutdown():
    if mqtt_client:
        mqtt_client.loop_stop()
        mqtt_client.disconnect()

@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "frontend" / "index.html")

app.mount("/static", StaticFiles(directory=BASE_DIR / "frontend"), name="static")

@app.get("/api/health")
async def health():
    return {"ok": True, "mqtt_connected": bool(mqtt_client and mqtt_client.is_connected()), "mqtt_error": mqtt_error, "mode": "hardware"}

@app.get("/api/machines")
async def machines():
    return [{"machine_id": k, "last_seen": v["timestamp"]} for k, v in latest.items()]

@app.get("/api/telemetry/latest")
async def telemetry_latest():
    if latest:
        return list(latest.values())
    history = database.get_telemetry(1)
    return history[-1:] if history else []

@app.get("/api/telemetry/history")
async def telemetry_history(limit: int = 300):
    return database.get_telemetry(max(1, min(limit, 2000)))

@app.get("/api/alarms")
async def alarms():
    return database.get_alarms()

@app.post("/api/alarms/{alarm_id}/acknowledge")
async def acknowledge(alarm_id: int):
    if not database.acknowledge_alarm(alarm_id):
        raise HTTPException(status_code=404, detail="Alarm not found")
    return {"ok": True, "alarm_id": alarm_id, "acknowledged": True}

@app.post("/api/telemetry")
async def ingest_telemetry(payload: Telemetry):
    data = payload.model_dump()
    process_telemetry(data)
    return {"ok": True, "received": data["machine_id"]}

@app.websocket("/ws/telemetry")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        if latest:
            await ws.send_json({"type": "snapshot", "data": list(latest.values())})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        clients.discard(ws)
