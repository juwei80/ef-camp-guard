/*
 * CampGuard — Event-driven AC-IN limiting with a single-loop finite state machine
 *
 * Description
 * ===========
 * This Shelly script coordinates a Shelly switch (AC input side) with an EcoFlow
 * power station to respect a configurable grid-current limit while maximizing charge rate.
 * It listens to Shelly events (toggle, power updates, overcurrent) and EcoFlow MQTT quota
 * messages, and uses a rolling 10-second window to track the peak apparent power.
 *
 * Core ideas:
 * - A single heartbeat (1 Hz) drives everything (watchdogs, restore attempts, optimization).
 * - Overcurrent (OC) is a *latched condition* that is only cleared by the explicit
 *   "overcurrent_clear" event from Shelly (never via polling).
 * - While in OC, the script periodically evaluates whether it is safe to restore:
 *   1) It sets EcoFlow AC-in charge power to a safe initial value.
 *   2) It turns the Shelly back on (the OC flag itself is **not** cleared here).
 * - During normal operation (no OC), the optimizer computes the target EcoFlow
 *   charge power from the available grid limit minus other loads, with rounding and
 *   minimum deltas to avoid flapping.
 *
 * Safety/Robustness:
 * - Rolling-window power tracking to capture short transients.
 * - Watchdogs re-register event handlers and MQTT subscriptions if they fall silent.
 * - Throttling of EcoFlow "SET" commands to avoid spamming.
 * - Optional throttling of restore attempts while OC is active.
 *
 * MQTT topics (prefix configurable via CFG.ecoPrefix):
 * - {prefix}quota:     incoming quota/telemetry from EcoFlow
 * - {prefix}set:       outgoing command to set AC-in charge power
 * - {prefix}set_reply: incoming ACK/error from EcoFlow
 *
 * Copyright & License
 * ===================
 * Copyright (c) 2025 Juergen Weiss <mail@juwei.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// [CampGuard] Event-driven AC-IN limiting with a single-loop FSM

let CFG = {
  name: "CampGuard",
  ecoPrefix: "ecoflow/",

  // Charge power limits (EcoFlow)
  initChargeW: 400,              // Safe initial charge after a restore
  minChargeW: 400,               // EcoFlow minimum
  maxChargeW: 2400,              // EcoFlow maximum
  safetyBufferW: 100,            // Safety headroom below grid limit
  quantW: 10,                    // Round target power to multiples of 10 W
  minDeltaW: 20,                 // Minimum change before sending a new SET

  // Timing
  windowSec: 10,                 // Rolling window for peak tracking
  optimizeEverySec: 10,          // Re-optimize every 10 s
  restoreDelaySec: 10,           // Earliest restore attempt 10 s after OC

  // Monitoring timeouts
  mqttTimeoutSec: 30,            // Quota deemed stale after 30 s
  eventTimeoutSec: 30,           // Shelly events deemed stale after 30 s
  quotaMaxAgeSec: 10,            // Quota max age to base decisions on

  // MQTT / SET throttling
  setThrottleSec: 5,             // Min spacing between EcoFlow SETs

  // Debug logs
  debugMode: false
};

// ---------- Utils
function nowS(){ return Math.floor(Date.now()/1000); }
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function roundQ(w){ return Math.round(w/CFG.quantW)*CFG.quantW; }
function dbg(m,o){ if(CFG.debugMode) print("["+CFG.name+"] "+m+(o?" "+JSON.stringify(o):"")); }
function log(m,o){ print("["+CFG.name+"] "+m+(o?" "+JSON.stringify(o):"")); }

// ---------- State
let S = {
  // Shelly
  on: false,                     // Current relay state
  oc: false,                     // Overcurrent latched state (cleared only by event)
  voltageV: 230,
  currentLimitA: 6,
  lastShellyEvtTS: 0,
  ocSinceTS: 0,

  // Power-Tracking (rolling window)
  measurements: [],              // Array of {ts, power}
  maxP10s: 0,
  lastTrackedPower: -1,
  lastTrackedTS: 0,

  // EcoFlow
  efAcOutW: 0,                   // AC output load attached to EcoFlow (consumers)
  efStandbyW: 20,                // EcoFlow internal overhead / inverter idle
  efChargeW: 400,                // Last commanded AC-in charge power
  lastQuotaTS: 0,

  // Command pacing / scheduling
  lastSetTS: 0,
  lastOptTS: 0,
  lastRestoreTryTS: 0,           // Used to avoid over-eager restore loops

  // Handler IDs
  shellyH: null,
  mqttQuotaH: null,
  mqttReplyH: null,

  // Timer
  heartbeat: null
};

// ---------- Rolling Window
function trackPower(powerW){
  let t = nowS();

  // Drop exact duplicates within the same second to reduce noise
  if(powerW === S.lastTrackedPower && t === S.lastTrackedTS) return;
  S.lastTrackedPower = powerW;
  S.lastTrackedTS = t;

  S.measurements.push({ts:t, power:powerW});
  updateMaxP10s();
  dbg("Power="+powerW+"W, Max10s="+S.maxP10s+"W, OC="+S.oc+", ON="+S.on);
}

function updateMaxP10s(){
  let t = nowS(), cutoff = t - CFG.windowSec;
  let maxp = 0, kept = [];
  for (let i=0;i<S.measurements.length;i++){
    let m = S.measurements[i];
    if (m.ts > cutoff){
      kept.push(m);
      if (m.power > maxp) maxp = m.power;
    }
  }
  S.measurements = kept;
  S.maxP10s = maxp;
}

function clearWindow(){
  S.measurements = [];
  S.maxP10s = 0;
  S.lastTrackedPower = -1;
  S.lastTrackedTS = 0;
}

// ---------- Limits
function maxGridW(){
  // Convert current limit (A) * measured voltage (V) to W (floored)
  return Math.floor(S.currentLimitA * S.voltageV);
}

// ---------- EcoFlow SET
function setEF(targetW){
  let t = nowS();
  if ((t - S.lastSetTS) < CFG.setThrottleSec){
    dbg("SET throttled");
    return false;
  }
  targetW = clamp(roundQ(targetW), CFG.minChargeW, CFG.maxChargeW);
  S.efChargeW = targetW;
  S.lastSetTS = t;

  // Construct EcoFlow command (cmdId/cmdFunc per device protocol)
  let msg = {
    id: Math.floor(Math.random()*1000000),
    version: "1.0",
    cmdId: 17,
    dirDest: 1, dirSrc: 1,
    cmdFunc: 254,
    dest: 2,
    needAck: 0,
    params: { cfgPlugInInfoAcInChgPowMax: targetW }
  };
  MQTT.publish(CFG.ecoPrefix + "set", JSON.stringify(msg), 1, false);
  log("→ EcoFlow SET: "+targetW+"W");
  return true;
}

// ---------- Optimization (normal operation)
function doOptimize(){
  // Compute available headroom and adjust EcoFlow AC-in power conservatively.
  let limitW = maxGridW();

  // Estimate "other loads" on the grid that are not the EcoFlow AC-in charger.
  // Prefer Shelly-measured peak when available and plausible; otherwise fallback to EF telemetry.
  let other;
  if (S.maxP10s > 0 && S.on){
    other = S.maxP10s - S.efChargeW;
    // Plausibility check: if negative or unreasonably high, fallback to EF values
    if (other < 0 || other > 2000) {
      other = S.efAcOutW + S.efStandbyW;
    }
  } else {
    // e.g., right after a restore (apower may still be 0) → use EF-only estimate
    other = S.efAcOutW + S.efStandbyW;
  }

  other = Math.max(0, Math.round(other));
  let target = limitW - other - CFG.safetyBufferW;
  target = clamp(roundQ(target), CFG.minChargeW, CFG.maxChargeW);

  if (Math.abs(target - S.efChargeW) >= CFG.minDeltaW){
    let dir = (target > S.efChargeW) ? "↑" : "↓";
    log("OPT: "+dir+" "+S.efChargeW+"W → "+target+"W", {maxP:S.maxP10s, other:other, limit:limitW});
    setEF(target);
  } else {
    dbg("OPT: no change (curr="+S.efChargeW+"W, target="+target+"W)");
  }
}

// ---------- Restore logic (only while OC is active)
function tryRestore(){
  // Only if OC is latched and min delay has passed
  if (!S.oc) return;
  let t = nowS();
  if (t - S.ocSinceTS < CFG.restoreDelaySec) return;

  // Optional light restore pacing to avoid hammering the device while OC persists
  if (t - S.lastRestoreTryTS < 3) return;
  S.lastRestoreTryTS = t;

  // Require fresh quota to base decisions on
  if ((t - S.lastQuotaTS) > CFG.quotaMaxAgeSec){
    dbg("Restore: EcoFlow quota too old");
    return;
  }

  // Expected grid draw after restore, based on EF data only
  let expected = CFG.initChargeW + S.efAcOutW + S.efStandbyW;
  let limitW = maxGridW();
  dbg("Restore check", {expected:expected, limit:limitW, acOut:S.efAcOutW, standby:S.efStandbyW});

  if (expected >= limitW){
    // Still no safe room to restore — wait for more headroom
    return;
  }

  // 1) Set EF to a safe initial charge power
  if (!setEF(CFG.initChargeW)) return;

  // 2) Turn Shelly back on — do NOT clear OC here (only the event may clear it)
  Shelly.call("Switch.Set", {id:0, on:true}, function(r,e){
    if (!e){
      log("✓ Shelly turned ON (restore)");
      // Cooldowns: prevent immediate optimizer down-adjust / rapid re-SET storm
      S.lastOptTS = nowS();
      S.lastSetTS = nowS();
    }
  });
}

// ---------- Shelly Event Handler (registered once)
function registerShellyHandler(){
  if (S.shellyH !== null){
    try { Shelly.removeEventHandler(S.shellyH); } catch(e){}
    S.shellyH = null;
  }

  // Small helpers keep the switch clearer
  function handleToggle(info){
    if (typeof info.state === "boolean"){
      S.on = info.state;
      log("Shelly toggle -> " + (S.on ? "ON" : "OFF"));
      if (!S.on) clearWindow();
    }
  }

  function handlePower(info){
    if (S.on && typeof info.apower === "number"){
      trackPower(info.apower);
    }
  }

  function handleOvercurrent(){
    S.oc = true;
    S.ocSinceTS = nowS();
    log("⚠️ Overcurrent event");
    S.on = false;     // Relay will be off right after OC
    clearWindow();
  }

  function handleOvercurrentClear(){
    S.oc = false;     // OC is cleared only by this explicit event
    dbg("Overcurrent cleared");
  }

  function handleConfigChanged(){
    // Re-read current limit (A). Voltage is tracked via status poll at init.
    pollCurrentLimit();
  }

  S.shellyH = Shelly.addEventHandler(function(ev){
    // Base guard
    if (!ev || !ev.info || ev.info.component !== "switch:0") return;

    S.lastShellyEvtTS = nowS();
    if (CFG.debugMode) dbg("ev.info", ev.info);

    let et = ev.info.event || "";
    switch (et){
      case "toggle":
        handleToggle(ev.info);
        break;

      case "power_measurement":
      case "power_update":
        handlePower(ev.info);
        break;

      case "overcurrent":
        handleOvercurrent();
        break;

      case "overcurrent_clear":
        handleOvercurrentClear();
        break;

      case "config_changed":
        handleConfigChanged();
        break;

      default:
        // Unknown/irrelevant events are silently ignored
        break;
    }
  });

  dbg("Shelly event handler registered");
}

// ---------- MQTT Handlers (registered once)
function registerMqttHandlers(){
  if (S.mqttQuotaH !== null){ try { MQTT.unsubscribe(S.mqttQuotaH); } catch(e){} S.mqttQuotaH = null; }
  if (S.mqttReplyH !== null){ try { MQTT.unsubscribe(S.mqttReplyH); } catch(e){} S.mqttReplyH = null; }

  // Quota / telemetry
  S.mqttQuotaH = MQTT.subscribe(CFG.ecoPrefix + "quota", function(topic,msg){
    S.lastQuotaTS = nowS();
    try {
      let data = JSON.parse(msg);
      let p = data.param || data.params || data || {};

      // EcoFlow AC-out (consumer load)
      if (typeof p.powGetAcHvOut === "number"){
        S.efAcOutW = Math.max(0, Math.abs(p.powGetAcHvOut));
      } else if (typeof p.powOutSumW === "number"){
        S.efAcOutW = Math.max(0, p.powOutSumW);
      }

      // EcoFlow own overhead (standby/inverter)
      if (typeof p.outputPower === "number"){
        S.efStandbyW = Math.max(20, p.outputPower);
      }

      dbg("EcoFlow: ACout="+S.efAcOutW+"W, Standby="+S.efStandbyW+"W");
    } catch(e){
      dbg("MQTT quota parse error: "+e.message);
    }
  });

  // SET replies / ACK
  S.mqttReplyH = MQTT.subscribe(CFG.ecoPrefix + "set_reply", function(topic,msg){
    try{
      let r = JSON.parse(msg);
      if (r && r.data){
        if (r.data.configOk === true){
          let ackW = r.data.cfgPlugInInfoAcInChgPowMax || S.efChargeW;
          log("✓ EcoFlow ACK: "+ackW+"W");
        } else if (r.data.ack === 0){
          log("⚠️ EcoFlow error: "+JSON.stringify(r));
        }
      }
    } catch(e){
      dbg("Reply parse error");
    }
  });

  dbg("MQTT handlers registered");
}

// ---------- Light polling (no continuous poller)
function pollCurrentLimit(){
  Shelly.call("Switch.GetConfig", {id:0}, function(r,e){
    if (!e && typeof r.current_limit === "number"){
      if (r.current_limit !== S.currentLimitA){
        S.currentLimitA = r.current_limit;
        log("Current limit: "+S.currentLimitA+"A ("+maxGridW()+"W)");
      }
    }
  });
}

function pollStatusOnce(){ // At init or after re-register
  Shelly.call("Switch.GetStatus", {id:0}, function(r,e){
    if (!e){
      if (typeof r.voltage === "number") S.voltageV = r.voltage;
      if (typeof r.output === "boolean")  S.on = r.output;
      // Do NOT clear OC by polling; only events may clear it.
      log("Initial: Shelly="+(S.on?"ON":"OFF")+", OC="+S.oc+", V="+S.voltageV);
    }
  });
}

// ---------- Heartbeat (single timer/loop)
function tick(){
  let t = nowS();

  // 1) Watchdogs / re-register handlers if silent for too long
  if ((t - S.lastShellyEvtTS) > CFG.eventTimeoutSec){
    log("⚠️ No Shelly events for "+(t - S.lastShellyEvtTS)+"s → re-register");
    registerShellyHandler();
    pollStatusOnce(); // one-time sanity check after re-register
    S.lastShellyEvtTS = t;
  }

  if ((t - S.lastQuotaTS) > CFG.mqttTimeoutSec){
    log("⚠️ No EcoFlow quota for "+(t - S.lastQuotaTS)+"s → MQTT re-sub");
    registerMqttHandlers();
  }

  // 2) Maintain rolling window
  updateMaxP10s();

  // 3) Restore path while OC is active
  if (S.oc){
    tryRestore();
    return; // While OC, skip optimization
  }

  // 4) Normal operation: periodic optimization
  if (S.on && (t - S.lastOptTS) >= CFG.optimizeEverySec){
    doOptimize();
    S.lastOptTS = t;
  }
}

// ---------- Init
function init(){
  log("=== "+CFG.name+" start ===");
  // Initialize timestamps to "now" to avoid spurious warnings at boot
  let t = nowS();
  S.lastQuotaTS = t;
  S.lastShellyEvtTS = t;
  S.lastOptTS = t; // avoid immediate optimize at startup

  registerMqttHandlers();
  registerShellyHandler();
  pollStatusOnce();
  pollCurrentLimit();

  // Single central timer (1 Hz)
  if (S.heartbeat) { try { Timer.clear(S.heartbeat); } catch(e){} }
  S.heartbeat = Timer.set(1000, true, tick);
}

init();