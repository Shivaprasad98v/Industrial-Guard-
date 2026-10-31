import json
import os
from datetime import datetime, timezone

try:
    import paho.mqtt.client as mqtt
except ImportError:
    mqtt = None

def start_mqtt(on_telemetry):
    if mqtt is None:
        return None, "paho-mqtt is not installed"

    host = os.getenv("MQTT_HOST", "127.0.0.1")
    port = int(os.getenv("MQTT_PORT", "1883"))
    topic = os.getenv("MQTT_TELEMETRY_TOPIC", "industrialguard/+/telemetry")
    username = os.getenv("MQTT_USERNAME", "")
    password = os.getenv("MQTT_PASSWORD", "")

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if username:
        client.username_pw_set(username, password)
    def on_connect(client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            client.subscribe(topic)
    def on_message(client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
            payload.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
            payload.setdefault("machine_id", msg.topic.split("/")[1] if len(msg.topic.split("/")) > 1 else "Machine 01")
            on_telemetry(payload)
        except Exception as exc:
            print(f"Rejected invalid MQTT message: {exc}")
    client.on_connect = on_connect
    client.on_message = on_message
    try:
        client.connect(host, port, 60)
        client.loop_start()
        return client, None
    except Exception as exc:
        return None, str(exc)
