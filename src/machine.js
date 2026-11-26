"use strict";
/**
 * Model stroje – čistá simulace bez závislosti na OPC UA.
 *
 * Každý tag má:
 *   - SP  (setpoint, žádaná hodnota)
 *   - "skutečný" stav bez šumu (_state), který sleduje cíl jako soustava 1. řádu
 *   - PV  = _state + šum, oříznuté do rozsahu
 *
 * Šum se nepřičítá do vnitřního stavu, aby nevznikala náhodná procházka.
 */
const { EventEmitter } = require("events");

class Machine extends EventEmitter {
    /**
     * @param {object} machineConfig    config.machine
     * @param {object} simulationConfig config.simulation
     */
    constructor(machineConfig, simulationConfig) {
        super();
        this.name = machineConfig.name;
        this.ambientTemperature = simulationConfig.ambientTemperature;
        this.updateIntervalMs = simulationConfig.updateIntervalMs;
        this.running = simulationConfig.initialRunning;
        this._timer = null;
        this._lastTick = null;

        this.tags = {};
        for (const [tagName, cfg] of Object.entries(machineConfig.tags)) {
            const initial = this.running ? cfg.defaultSP : this._stoppedTarget(cfg);
            this.tags[tagName] = {
                name: tagName,
                cfg,
                sp: cfg.defaultSP,
                _state: clamp(initial, cfg.range),
                pv: clamp(initial, cfg.range)
            };
        }
    }

    /** Seznam jmen tagů (Temperature, Pressure, Speed). */
    get tagNames() {
        return Object.keys(this.tags);
    }

    getPV(tagName) {
        return this._tag(tagName).pv;
    }

    getSP(tagName) {
        return this._tag(tagName).sp;
    }

    getRange(tagName) {
        return { ...this._tag(tagName).cfg.range };
    }

    /** Je hodnota v povoleném rozsahu tagu? */
    isInRange(tagName, value) {
        const { low, high } = this._tag(tagName).cfg.range;
        return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
    }

    /**
     * Nastaví SP. Hodnotu mimo rozsah odmítne (vrací false, SP se nemění).
     */
    setSP(tagName, value) {
        if (!this.isInRange(tagName, value)) {
            return false;
        }
        const tag = this._tag(tagName);
        const old = tag.sp;
        tag.sp = value;
        this.emit("spChanged", tagName, value, old);
        return true;
    }

    setRunning(value) {
        const old = this.running;
        this.running = !!value;
        if (old !== this.running) {
            this.emit("runningChanged", this.running, old);
        }
    }

    start() {
        if (this._timer) return;
        this._lastTick = Date.now();
        this._timer = setInterval(() => this.step(), this.updateIntervalMs);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /**
     * Jeden krok simulace. dtSec lze předat ručně (např. v testech),
     * jinak se počítá ze skutečně uplynulého času.
     */
    step(dtSec) {
        const now = Date.now();
        if (dtSec === undefined) {
            dtSec = (now - this._lastTick) / 1000;
        }
        this._lastTick = now;

        for (const tag of Object.values(this.tags)) {
            const { cfg } = tag;
            let target, tau, noiseAmp;
            if (this.running) {
                target = tag.sp;
                tau = cfg.timeConstantSec;
                noiseAmp = cfg.noise;
            } else {
                target = this._stoppedTarget(cfg);
                tau = cfg.stopped.timeConstantSec;
                noiseAmp = cfg.stopped.noise ? cfg.noise : 0;
            }

            // Diskrétní soustava 1. řádu (přesná diskretizace pro proměnné dt)
            const alpha = 1 - Math.exp(-dtSec / tau);
            tag._state = clamp(tag._state + (target - tag._state) * alpha, cfg.range);

            const noise = (Math.random() * 2 - 1) * noiseAmp;
            tag.pv = clamp(tag._state + noise, cfg.range);
        }
        this.emit("updated");
    }

    _stoppedTarget(cfg) {
        return cfg.stopped.target === "ambient" ? this.ambientTemperature : cfg.stopped.target;
    }

    _tag(tagName) {
        const tag = this.tags[tagName];
        if (!tag) throw new Error(`Unknown tag: ${tagName}`);
        return tag;
    }
}

function clamp(value, { low, high }) {
    return Math.min(high, Math.max(low, value));
}

module.exports = { Machine };
