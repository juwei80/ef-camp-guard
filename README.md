# CampGuard

**Event-driven load guard for EcoFlow power stations with Shelly integration**

CampGuard monitors a Shelly switch on the AC-input side of an EcoFlow power station and dynamically adapts the EcoFlow’s AC-in charging power to stay within a safe current limit (e.g. campsite breaker).
It is ideal for RVs, campers or off-grid setups where you want to charge efficiently from limited AC supplies without tripping breakers.

---

## Features

- **Overcurrent protection:** Detects breaker trips (via Shelly overcurrent event) and prevents endless retry loops.
- **Safe restore logic:** Attempts to re-enable charging only when headroom is available.
- **Dynamic optimization:** Continuously adapts EcoFlow charging power to use available headroom without overload.
- **Event-driven:** Uses Shelly events (toggle, power, overcurrent) and EcoFlow MQTT telemetry.
- **Robust design:** Watchdogs for MQTT and event subscriptions, throttling for EcoFlow SET commands.

---

## Requirements

- A Shelly device (e.g. Switch/Plug) controlling your EcoFlow’s **AC-IN** side
- A local MQTT broker (e.g. Mosquitto on OpenWRT/Teltonika)
- An **EcoFlow Developer Account** with access/secret keys (see below)

---

## Installation

1. Copy content of `CampGuard.js` to your Shelly (Web UI → **Scripts** → New → paste).
2. Ensure your Shelly is connected to your **local** MQTT broker.
3. Set up an **MQTT bridge** on your local broker to the EcoFlow cloud broker (next section).
4. In `CampGuard.js`, adjust `CFG` (power limits, topic prefix, etc.).

---

## MQTT Bridge Setup (EcoFlow → local broker)

EcoFlow devices publish telemetry (quota, status) and accept commands (set, set_reply) only via their **cloud MQTT broker**.
To use them locally, bridge the EcoFlow topics into your local broker (e.g. Mosquitto on OpenWRT/Teltonika).

### How to get your EcoFlow MQTT credentials

You’ll need official credentials from EcoFlow (Developer program). High-level steps:

1. Sign up / log in at the **EcoFlow Developer portal** and request access.
2. Create **Access Key**.
3. Call the certification endpoint to fetch your MQTT connection data (see next section).

### Fetch MQTT credentials

The EcoFlow API expects a **signed** request with four headers: `accessKey`, `nonce`, `timestamp`, `sign`.
The signature is an **HMAC-SHA256** over the string `"accessKey=<...>&nonce=<...>&timestamp=<...>"` using your **Secret Key** as HMAC key.
Endpoint: `GET https://api.ecoflow.com/iot-open/sign/certification`

```bash
# --- Fill these with your Developer keys ---
ACCESS_KEY="YOUR_ACCESS_KEY"
SECRET_KEY="YOUR_SECRET_KEY"

# Nonce: any random integer; Timestamp: milliseconds since epoch
NONCE=$((RANDOM + 10000))
TIMESTAMP=$(( $(date +%s) * 1000 ))

# Build signing string and compute HMAC-SHA256 (lowercase hex)
STRING="accessKey=${ACCESS_KEY}&nonce=${NONCE}&timestamp=${TIMESTAMP}"
SIGN=$(printf "%s" "$STRING" | openssl dgst -sha256 -hmac "$SECRET_KEY" -r | awk '{print $1}' | tr 'A-Z' 'a-z')

# Call the certification endpoint
curl -sS "https://api.ecoflow.com/iot-open/sign/certification"   -H "accessKey: ${ACCESS_KEY}"   -H "nonce: ${NONCE}"   -H "timestamp: ${TIMESTAMP}"   -H "sign: ${SIGN}"
```

Expected response (example):

```json
{
  "code": "0",
  "message": "Success",
  "data": {
    "certificateAccount": "open-e05XXXXXXXXXXX",
    "certificatePassword": "c726cfXXXXXXXXX",
    "url": "mqtt-e.ecoflow.com",
    "port": "8883",
    "protocol": "mqtts"
  }
}
```

Use:
- `certificateAccount` → `remote_username`
- `certificatePassword` → `remote_password`
- `url:port` → `mqtt-e.ecoflow.com:8883`

### Mosquitto bridge config (OpenWRT/Teltonika)

Create `/etc/mosquitto/ecoflow.conf`:

```conf
# ===== EcoFlow Bridge =====
connection ecoflow
address mqtt-e.ecoflow.com:8883

# Credentials from the certification response
remote_username <YOUR_certificateAccount>
remote_password <YOUR_certificatePassword>
remote_clientid EcoFlowClient_<UNIQUE_ID>

# TLS & protocol
bridge_tls_version tlsv1.2
bridge_cafile /etc/ssl/certs/ca-certificates.crt
bridge_protocol_version mqttv311
try_private false
cleansession true
keepalive_interval 300
start_type automatic
restart_timeout 10 120
notifications true
notifications_local_only false

# Topic mapping (EcoFlow <-> local broker)
# Left: local prefix used by CampGuard (e.g. 'ecoflow/')
# Right: remote EcoFlow paths (replace with your account & device SN)
topic quota     in  1 ecoflow/ /open/<YOUR_certificateAccount>/<YOUR_DEVICE_SN>/
topic status    in  1 ecoflow/ /open/<YOUR_certificateAccount>/<YOUR_DEVICE_SN>/
topic set_reply in  1 ecoflow/ /open/<YOUR_certificateAccount>/<YOUR_DEVICE_SN>/
topic set       out 1 ecoflow/ /open/<YOUR_certificateAccount>/<YOUR_DEVICE_SN>/
```

Tell Mosquitto (UCI) to load it:

```bash
uci set mosquitto.mqtt=mosquitto
uci set mosquitto.mqtt.enabled='1'
uci set mosquitto.mqtt.custom_enabled='1'
uci set mosquitto.mqtt.custom_section_id='/etc/mosquitto/ecoflow.conf'
uci commit mosquitto
/etc/init.d/mosquitto restart
```

Verify the bridge:

```bash
mosquitto_sub -v -t 'ecoflow/#'
```

You should see messages like:

```
ecoflow/quota {"param":{...}}
ecoflow/status {"param":{...}}
```

---

## CampGuard topic usage

CampGuard subscribes/publishes under your **local** prefix (default `ecoflow/`):

- **Subscribe:** `ecoflow/quota`, `ecoflow/status`, `ecoflow/set_reply`
- **Publish:** `ecoflow/set` (to adjust AC-in charging power)

These are bridged to the corresponding EcoFlow cloud topics by Mosquitto using the `topic` lines above.

---

## License

CampGuard
Copyright (c) 2025 Juergen Weiss <mail@juwei.de>

Licensed under the [GNU Affero General Public License v3.0 or later](https://www.gnu.org/licenses/agpl-3.0.html).
See [LICENSE](LICENSE) for details.
