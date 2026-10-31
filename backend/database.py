import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "industrialguard.db"

def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with connect() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS telemetry (
            id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL,
            timestamp TEXT NOT NULL, vibration_rms REAL, rpm REAL,
            ambient_temperature REAL, humidity REAL, gas_sensor_raw REAL,
            enclosure_closed INTEGER, fault_code INTEGER, payload_json TEXT
        )""")
        columns = {r[1] for r in conn.execute("PRAGMA table_info(telemetry)")}
        if "payload_json" not in columns:
            conn.execute("ALTER TABLE telemetry ADD COLUMN payload_json TEXT")
        conn.execute("""CREATE TABLE IF NOT EXISTS alarms (
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
            machine_id TEXT NOT NULL, parameter TEXT NOT NULL, value TEXT NOT NULL,
            severity TEXT NOT NULL, description TEXT NOT NULL,
            acknowledged INTEGER NOT NULL DEFAULT 0
        )""")

def save_telemetry(d):
    with connect() as conn:
        conn.execute("""INSERT INTO telemetry
            (machine_id,timestamp,vibration_rms,rpm,ambient_temperature,humidity,gas_sensor_raw,enclosure_closed,fault_code,payload_json)
            VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (d.get("machine_id", "Machine 01"), d["timestamp"], d.get("vibration_rms"),
             d.get("rpm"), d.get("ambient_temperature"), d.get("humidity"),
             d.get("gas_sensor_raw"), None if d.get("enclosure_closed") is None else int(bool(d.get("enclosure_closed"))),
             int(d.get("fault_code", 0) or 0), json.dumps(d)))

def save_alarm(a):
    with connect() as conn:
        cur = conn.execute("""INSERT INTO alarms
            (timestamp,machine_id,parameter,value,severity,description,acknowledged)
            VALUES (?,?,?,?,?,?,0)""",
            (a["timestamp"], a["machine_id"], a["parameter"], str(a["value"]), a["severity"], a["description"]))
        return cur.lastrowid

def get_telemetry(limit=300):
    with connect() as conn:
        rows = conn.execute("SELECT * FROM telemetry ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        result = []
        for row in reversed(rows):
            item = dict(row)
            payload = item.pop("payload_json", None)
            if payload:
                try: item.update(json.loads(payload))
                except json.JSONDecodeError: pass
            result.append(item)
        return result

def get_alarms(limit=200):
    with connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM alarms ORDER BY id DESC LIMIT ?", (limit,)).fetchall()]

def acknowledge_alarm(alarm_id):
    with connect() as conn:
        cur = conn.execute("UPDATE alarms SET acknowledged=1 WHERE id=?", (alarm_id,))
        return cur.rowcount > 0
