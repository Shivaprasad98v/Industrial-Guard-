import json
import os
import ssl
from datetime import datetime, timezone

try:
    import paho.mqtt.client as mqtt
except ImportError:
    mqtt = None


def start_mqtt(on_telemetry):
    if mqtt is None:
        return None, "paho-mqtt is not installed"

    # EMQX Cloud connection settings
    host = os.getenv("MQTT_HOST", "")
    port = int(os.getenv("MQTT_PORT", "8883"))
    topic = os.getenv(
        "MQTT_TELEMETRY_TOPIC",
        "industrialguard/+/telemetry"
    )
    username = os.getenv("MQTT_USERNAME", "")
    password = os.getenv("MQTT_PASSWORD", "")
    ca_file = os.getenv("MQTT_CA_CERT", "").strip()

    if not host:
        return None, "MQTT_HOST is not configured"

    if not username or not password:
        return None, "MQTT username or password is missing"

    try:
        # Create an MQTT client
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="industrialguard_render_backend",
            protocol=mqtt.MQTTv311
        )

        # MQTT authentication
        client.username_pw_set(username, password)

        # TLS certificate verification
        if ca_file:
            tls_context = ssl.create_default_context(cafile=ca_file)
        else:
            # Use the operating system's trusted CA certificates
            tls_context = ssl.create_default_context()

        client.tls_set_context(tls_context)
        client.tls_insecure_set(False)

        # Reconnection delay: 1 to 60 seconds
        client.reconnect_delay_set(min_delay=1, max_delay=60)

        def on_connect(client, userdata, flags, reason_code, properties):
            if reason_code == 0:
                print("Connected securely to EMQX Cloud")

                result, mid = client.subscribe(topic, qos=0)

                if result == mqtt.MQTT_ERR_SUCCESS:
                    print(f"Subscribed to MQTT topic: {topic}")
                else:
                    print(f"MQTT subscription request failed: {result}")
            else:
                print(f"EMQX connection rejected: {reason_code}")

        def on_disconnect(
            client, userdata, disconnect_flags, reason_code, properties
        ):
            print(f"MQTT disconnected: {reason_code}. Reconnection will be attempted.")

        def on_message(client, userdata, msg):
            try:
                payload = json.loads(msg.payload.decode("utf-8"))

                if not isinstance(payload, dict):
                    raise ValueError("Telemetry payload must be a JSON object")

                payload.setdefault(
                    "timestamp",
                    datetime.now(timezone.utc).isoformat()
                )

                parts = msg.topic.split("/")
                payload.setdefault(
                    "machine_id",
                    parts[1] if len(parts) > 2 else "Machine01"
                )

                on_telemetry(payload)

            except Exception as exc:
                print(f"Rejected invalid MQTT message: {exc}")

        client.on_connect = on_connect
        client.on_disconnect = on_disconnect
        client.on_message = on_message

        # Asynchronous connection; Paho's network loop handles retries
        client.connect_async(host, port, keepalive=60)
        client.loop_start()

        print(f"Starting MQTT connection to {host}:{port}")

        return client, None

    except Exception as exc:
        print(f"MQTT startup error: {exc}")
        return None, str(exc)