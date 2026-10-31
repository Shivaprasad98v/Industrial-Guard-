# IndustrialGuard AI — upgraded dashboard

A responsive industrial monitoring dashboard with a FastAPI backend, MQTT ingestion, WebSocket live updates, SQLite history, alarm acknowledgement and CSV exports. The frontend does **not** invent sensor readings: it shows waiting/unknown states until telemetry arrives from the ESP32.

## 1. Start on Windows (PowerShell)

```powershell
cd IndustrialGuardAI
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
Copy-Item .env.example .env
uvicorn backend.main:app --reload
```

Open `http://127.0.0.1:8000`. API docs: `http://127.0.0.1:8000/docs`.

If PowerShell blocks activation, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` in that terminal, then activate again. If activation is still inconvenient, you can install and start using the virtual-environment interpreter directly:
```powershell
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload
```

## 2. MQTT configuration

The backend subscribes to `industrialguard/+/telemetry` by default. Configure `.env` to match your broker:

```env
MQTT_HOST=127.0.0.1
MQTT_PORT=1883
MQTT_USERNAME=
MQTT_PASSWORD=
MQTT_TELEMETRY_TOPIC=industrialguard/+/telemetry
```

The MQTT broker must be running and reachable from the computer running FastAPI. `127.0.0.1` means the same computer, not the ESP32. The ESP32 publishes to the broker's LAN IP address; the browser connects to FastAPI.

## 3. ESP32 telemetry JSON contract

Publish one JSON packet periodically (for example every 1 second) to `industrialguard/machine01/telemetry`. Send state changes in `events` as they happen. Example packet:

```json
{
  "machine_id": "Machine 01",
  "timestamp": "2026-10-31T10:00:00+05:30",
  "sequence": 125,
  "mpu6050": {
    "acceleration": {"x": 0.12, "y": -0.08, "z": 9.79},
    "gyroscope": {"x": 0.01, "y": 0.02, "z": -0.01},
    "vibration_rms_g": 0.08
  },
  "sw420": {"digital_output": 0, "detected": false},
  "dht22": {"temperature_c": 31.8, "humidity_pct": 57.2},
  "a3144": {"magnet_detected": false, "pulses_per_second": 24, "rpm": 1440},
  "mq2": {"enabled": false, "raw_adc": null, "voltage_v": null},
  "mc38": {"closed": true},
  "sensor_status": {
    "mpu6050": "connected",
    "sw420": "connected",
    "dht22": "connected",
    "a3144": "connected",
    "mq2": "not_tested",
    "mc38": "connected"
  },
  "outputs": {"buzzer_on": false, "relay_on": false},
  "events": []
}
```

Allowed sensor status values used by the UI: `connected`, `disconnected`, `warning`, `not_tested`. Unknown/missing status is displayed as **NOT REPORTED**, never assumed connected.

For a state transition, send an event such as:

```json
{"sensor":"SW-420","value":"Vibration detected","severity":"Warning","message":"Digital output changed to active"}
```

The `events` array is stored as part of telemetry and also creates alarm records. Do not send every repeated loop message as a new event; send events on transitions, while periodic telemetry carries the latest readings and status.

## 4. Sensor-specific notes

- **MPU6050:** send acceleration in m/s² and gyroscope in rad/s. The dashboard shows axes. For reliable vibration RMS/FFT, sample at a consistent rate, remove gravity/DC offset, and compute RMS/FFT over a sample window. Raw acceleration magnitude changes alone are not a complete vibration analysis.
- **SW-420:** send `digital_output` and `detected`. A digital output stuck HIGH/LOW is not sufficient to diagnose a disconnected module. Add suitable line supervision if true cable-disconnect detection is required.
- **DHT22:** send only valid readings. On read failure, report `sensor_status.dht22 = "warning"` or `"disconnected"` according to firmware diagnostics; don't substitute zero.
- **A3144:** `magnet_detected: false` means no magnet is currently detected, not that the sensor is disconnected. Report sensor health separately. RPM assumes known pulses per revolution.
- **MC-38:** `closed: false` means the enclosure is open, not a disconnected sensor. True wire-break detection requires extra circuitry/diagnostics.
- **MQ-2:** raw ADC is not ppm and cannot identify a specific gas. It is intentionally disabled in the example. Keep it disconnected until the previously reported unusual smell has been investigated and the module is confirmed safe. Do not use a match/flame to test it.

## 5. Important behavior

- Frontend waits for real telemetry; no random/demo values are presented as live measurements.
- Sensor connection status is taken from explicit firmware `sensor_status` diagnostics where available. The dashboard does not infer connection merely from a normal sensor state.
- Backend stores telemetry and alarms in `backend/industrialguard.db`.
- WebSocket endpoint: `/ws/telemetry`.
- REST ingestion endpoint for local testing: `POST /api/telemetry`.
- Alarm thresholds in `backend/main.py` are example thresholds and must be calibrated to the actual machine and sensor installation before use.
- The dashboard is a student prototype, not certified industrial safety equipment. Do not use it as the sole safety interlock or emergency-stop system.

## 6. MQTT test without ESP32 (optional)

After starting the backend and an MQTT broker, publish a sample JSON packet to `industrialguard/machine01/telemetry` using an MQTT client. The dashboard should update without a browser refresh. This tests the data path only, not the sensors.


## 7. Premium UI additions

- Animated status indicators, subtle glow accents, responsive cards and improved visual hierarchy.
- Quick Jump navigation: click the Quick jump control or press Ctrl+K / Cmd+K, then enter a page name.
- Maintenance Planner: create, prioritize, assign, complete and delete inspection tasks.
- Shift handover notes with automatic browser-local saving.
- Telemetry freshness watchdog: if the last ESP32 packet is older than 15 seconds, the interface marks the feed as stale instead of continuing to imply that data is live.

**Maintenance planner storage note:** tasks and handover notes are stored in the current browser's local storage. They are not synchronized between computers or users and are not part of the SQLite database yet.
