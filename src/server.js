"use strict";
/**
 * OPC UA server – mapuje model stroje (machine.js) na adresní prostor.
 *
 *   Objects/Machine1/{Temperature,Pressure,Speed}/{PV,SP}
 *   Objects/Machine1/Running
 *
 * NodeId: ns=<idx>;s=Machine1.Temperature.PV apod.
 */
const {
    OPCUAServer,
    Variant,
    DataType,
    StatusCodes,
    AttributeIds,
    MessageSecurityMode,
    SecurityPolicy,
    standardUnits
} = require("node-opcua");

// SP a Running mají getter -> server je pro subscriptions vzorkuje s touto periodou [ms]
const SAMPLING_INTERVAL_MS = 100;

class MachineServer {
    /**
     * @param {object} config  celý config.js
     * @param {import("./machine").Machine} machine
     * @param {(msg: string) => void} [log]
     */
    constructor(config, machine, log = defaultLog) {
        this.config = config;
        this.machine = machine;
        this.log = log;
        this.server = null;
        this.namespaceIndex = null;
        this.nodeIds = [];          // pro výpis při startu
        this._pvNodes = {};         // tagName -> UAVariable
        this._onUpdated = null;
    }

    get endpointUrl() {
        const { port, resourcePath } = this.config.server;
        return `opc.tcp://localhost:${port}${resourcePath}`;
    }

    async start() {
        const s = this.config.server;
        this.server = new OPCUAServer({
            port: s.port,
            resourcePath: s.resourcePath,
            buildInfo: {
                productName: s.productName,
                buildNumber: "1",
                buildDate: new Date()
            },
            serverInfo: {
                applicationName: { text: s.applicationName, locale: "en" }
            },
            // Vývojové prostředí: bez zabezpečení, anonymní přístup
            securityModes: [MessageSecurityMode.None],
            securityPolicies: [SecurityPolicy.None],
            allowAnonymous: true
        });

        await this.server.initialize();
        this._buildAddressSpace();
        await this.server.start();

        // Při každém kroku simulace propsat PV do uzlů -> notifikace pro subscriptions
        this._onUpdated = () => this._publishPVs();
        this.machine.on("updated", this._onUpdated);
    }

    async stop() {
        if (this._onUpdated) {
            this.machine.off("updated", this._onUpdated);
            this._onUpdated = null;
        }
        if (this.server) {
            await this.server.shutdown(1000);
            this.server = null;
        }
    }

    // ------------------------------------------------------------------
    // Adresní prostor
    // ------------------------------------------------------------------

    _buildAddressSpace() {
        const addressSpace = this.server.engine.addressSpace;
        const namespace = addressSpace.registerNamespace(this.config.server.namespaceUri);
        this.namespaceIndex = namespace.index;
        const machineName = this.machine.name;

        const machineObj = namespace.addObject({
            organizedBy: addressSpace.rootFolder.objects,
            browseName: machineName,
            nodeId: `s=${machineName}`
        });

        for (const tagName of this.machine.tagNames) {
            const tagCfg = this.machine.tags[tagName].cfg;
            const prefix = `${machineName}.${tagName}`;
            const unit = resolveUnit(tagCfg.unit);
            const range = tagCfg.range;

            const tagObj = namespace.addObject({
                componentOf: machineObj,
                browseName: tagName,
                nodeId: `s=${prefix}`
            });

            // PV – pouze čtení, hodnotu nastavuje simulace
            const pv = namespace.addAnalogDataItem({
                componentOf: tagObj,
                browseName: "PV",
                nodeId: `s=${prefix}.PV`,
                dataType: "Double",
                accessLevel: "CurrentRead",
                userAccessLevel: "CurrentRead",
                engineeringUnitsRange: { low: range.low, high: range.high },
                engineeringUnits: unit,
                value: new Variant({ dataType: DataType.Double, value: this.machine.getPV(tagName) })
            });
            this._pvNodes[tagName] = pv;
            this._hookWrites(pv, `${prefix}.PV`);

            // SP – čtení i zápis, kontrola rozsahu
            const sp = namespace.addAnalogDataItem({
                componentOf: tagObj,
                browseName: "SP",
                nodeId: `s=${prefix}.SP`,
                dataType: "Double",
                accessLevel: "CurrentRead | CurrentWrite",
                userAccessLevel: "CurrentRead | CurrentWrite",
                engineeringUnitsRange: { low: range.low, high: range.high },
                engineeringUnits: unit,
                minimumSamplingInterval: SAMPLING_INTERVAL_MS,
                value: {
                    get: () => new Variant({ dataType: DataType.Double, value: this.machine.getSP(tagName) }),
                    set: (variant) =>
                        this.machine.setSP(tagName, variant.value) ? StatusCodes.Good : StatusCodes.BadOutOfRange
                }
            });
            this._hookWrites(sp, `${prefix}.SP`, (variant) =>
                variant.dataType === DataType.Double && !this.machine.isInRange(tagName, variant.value)
                    ? StatusCodes.BadOutOfRange
                    : null
            );

            this.nodeIds.push(`${prefix}.PV`, `${prefix}.SP`);
        }

        // Running – Boolean, čtení i zápis
        const running = namespace.addVariable({
            componentOf: machineObj,
            browseName: "Running",
            nodeId: `s=${machineName}.Running`,
            dataType: "Boolean",
            accessLevel: "CurrentRead | CurrentWrite",
            userAccessLevel: "CurrentRead | CurrentWrite",
            minimumSamplingInterval: SAMPLING_INTERVAL_MS,
            value: {
                get: () => new Variant({ dataType: DataType.Boolean, value: this.machine.running }),
                set: (variant) => {
                    this.machine.setRunning(variant.value);
                    return StatusCodes.Good;
                }
            }
        });
        this._hookWrites(running, `${machineName}.Running`);
        this.nodeIds.push(`${machineName}.Running`);
    }

    _publishPVs() {
        for (const [tagName, node] of Object.entries(this._pvNodes)) {
            node.setValueFromSource({ dataType: DataType.Double, value: this.machine.getPV(tagName) });
        }
    }

    /**
     * Obalí writeAttribute uzlu: přidá vlastní validaci a zaloguje každý zápis
     * hodnoty (kdo, co, nová hodnota, výsledek).
     *
     * @param {object} node
     * @param {string} name     čitelné jméno tagu pro log
     * @param {(variant: Variant) => (StatusCode|null)} [validate]
     *        vrátí chybový StatusCode pro odmítnutí, nebo null = pokračovat
     */
    _hookWrites(node, name, validate) {
        const original = node.writeAttribute.bind(node);

        node.writeAttribute = (context, writeValue, callback) => {
            // Promise varianta (bez callbacku) – sjednotit na callback
            if (typeof callback !== "function") {
                return new Promise((resolve, reject) =>
                    node.writeAttribute(context, writeValue, (err, sc) => (err ? reject(err) : resolve(sc)))
                );
            }
            if (writeValue.attributeId !== AttributeIds.Value) {
                return original(context, writeValue, callback);
            }

            const variant = writeValue.value && writeValue.value.value;
            const who = describeClient(context);
            const shown = variant ? formatVariant(variant) : "<null>";

            const done = (err, statusCode) => {
                if (err) {
                    this.log(`WRITE ERROR  ${name} = ${shown} by ${who}: ${err.message}`);
                } else if (statusCode && statusCode.isGood()) {
                    this.log(`WRITE OK     ${name} = ${shown} by ${who}`);
                } else {
                    this.log(`WRITE REJECT ${name} = ${shown} by ${who} -> ${statusCode && statusCode.name}`);
                }
                callback(err, statusCode);
            };

            if (validate && variant) {
                const rejection = validate(variant);
                if (rejection) {
                    return done(null, rejection);
                }
            }
            return original(context, writeValue, done);
        };
    }
}

// ----------------------------------------------------------------------
// Pomocné funkce
// ----------------------------------------------------------------------

function resolveUnit(key) {
    const unit = standardUnits[key];
    if (!unit) {
        throw new Error(`Unknown engineering unit '${key}' (see node-opcua standardUnits)`);
    }
    return unit;
}

function describeClient(context) {
    const session = context && context.session;
    if (!session) return "<internal>";
    const parts = [];
    if (session.sessionName) parts.push(`session "${session.sessionName}"`);
    const ch = session.channel;
    if (ch && ch.remoteAddress) parts.push(`${ch.remoteAddress}:${ch.remotePort}`);
    const user = typeof context.getUserName === "function" ? context.getUserName() : null;
    parts.push(`user ${user || "anonymous"}`);
    return parts.join(", ");
}

function formatVariant(variant) {
    return `${variant.value} (${DataType[variant.dataType]})`;
}

function defaultLog(msg) {
    console.log(`${new Date().toISOString()}  ${msg}`);
}

module.exports = { MachineServer };
