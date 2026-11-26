"use strict";
/**
 * Testovací OPC UA klient pro simulátor stroje.
 *
 *  1. přečte všechny tagy (PV, SP, Running) včetně EngineeringUnits a EURange
 *  2. zapíše nový SP teploty a ověří zpětným čtením
 *  3. ověří odmítnutí zápisu SP mimo rozsah (BadOutOfRange) a zápisu do PV (BadNotWritable)
 *  4. přes subscription sleduje, jak se Temperature.PV blíží k novému SP
 *  5. ověří Running = false -> Speed klesá k 0, pak Running = true
 *
 * Použití:  npm test            (server musí běžet: npm start)
 *           node test/client-test.js [dobaSledovaniSec]
 */
const {
    OPCUAClient,
    MessageSecurityMode,
    SecurityPolicy,
    AttributeIds,
    DataType,
    StatusCodes,
    TimestampsToReturn,
    ClientMonitoredItem,
    makeBrowsePath
} = require("node-opcua");
const config = require("../config");

const ENDPOINT = `opc.tcp://localhost:${config.server.port}${config.server.resourcePath}`;
const WATCH_SECONDS = Number(process.argv[2]) || 15;
const NEW_TEMP_SP = 80;
const OUT_OF_RANGE_SP = 200;

let failures = 0;
function check(condition, message) {
    console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
    if (!condition) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const client = OPCUAClient.create({
        applicationName: "MachineSimulatorTestClient",
        clientName: "client-test", // objeví se v serverovém logu jako jméno session
        securityMode: MessageSecurityMode.None,
        securityPolicy: SecurityPolicy.None,
        endpointMustExist: false,
        connectionStrategy: { maxRetry: 2, initialDelay: 500 }
    });

    console.log(`Connecting to ${ENDPOINT} ...`);
    await client.connect(ENDPOINT);
    const session = await client.createSession(); // anonymní přihlášení

    try {
        const nsArray = await session.readNamespaceArray();
        const ns = nsArray.indexOf(config.server.namespaceUri);
        if (ns < 0) throw new Error(`Namespace ${config.server.namespaceUri} not found on server`);
        const id = (s) => `ns=${ns};s=${config.machine.name}.${s}`;
        const tagNames = Object.keys(config.machine.tags);

        // ------------------------------------------------------------------
        console.log("\n[1] Read all tags");
        for (const tag of tagNames) {
            for (const kind of ["PV", "SP"]) {
                const nodeId = id(`${tag}.${kind}`);
                const dv = await session.read({ nodeId, attributeId: AttributeIds.Value });
                const props = await readAnalogProps(session, nodeId);
                console.log(
                    `  ${nodeId.padEnd(32)} = ${fmt(dv.value.value).padStart(9)} ${props.unit.padEnd(6)}` +
                        ` range ${props.range.low}..${props.range.high}  [${dv.statusCode.name}]`
                );
                check(dv.statusCode.isGood() && dv.value.dataType === DataType.Double, `${tag}.${kind} is Good Double`);
                const exp = config.machine.tags[tag].range;
                check(props.range.low === exp.low && props.range.high === exp.high, `${tag}.${kind} EURange matches config`);
            }
        }
        const runDv = await session.read({ nodeId: id("Running"), attributeId: AttributeIds.Value });
        console.log(`  ${id("Running").padEnd(32)} = ${runDv.value.value}`);
        check(runDv.value.dataType === DataType.Boolean, "Running is Boolean");

        // ------------------------------------------------------------------
        console.log(`\n[2] Write Temperature.SP = ${NEW_TEMP_SP}`);
        let sc = await writeDouble(session, id("Temperature.SP"), NEW_TEMP_SP);
        check(sc === StatusCodes.Good, `write accepted (${sc.name})`);
        let sp = (await session.read({ nodeId: id("Temperature.SP") })).value.value;
        check(sp === NEW_TEMP_SP, `read back SP = ${sp}`);

        // ------------------------------------------------------------------
        console.log(`\n[3] Rejected writes`);
        sc = await writeDouble(session, id("Temperature.SP"), OUT_OF_RANGE_SP);
        check(sc === StatusCodes.BadOutOfRange, `SP = ${OUT_OF_RANGE_SP} rejected with ${sc.name}`);
        sp = (await session.read({ nodeId: id("Temperature.SP") })).value.value;
        check(sp === NEW_TEMP_SP, `SP unchanged (${sp})`);

        sc = await writeDouble(session, id("Temperature.SP"), -1);
        check(sc === StatusCodes.BadOutOfRange, `SP = -1 rejected with ${sc.name}`);

        sc = await writeDouble(session, id("Temperature.PV"), 50);
        check(sc === StatusCodes.BadNotWritable, `write to PV rejected with ${sc.name}`);

        // ------------------------------------------------------------------
        console.log(`\n[4] Subscribe Temperature.PV for ${WATCH_SECONDS} s (SP = ${NEW_TEMP_SP})`);
        const samples = await watch(session, id("Temperature.PV"), WATCH_SECONDS * 1000, (v, t) =>
            console.log(`  t=${t.toFixed(1).padStart(5)} s  PV = ${fmt(v)}  error = ${fmt(NEW_TEMP_SP - v)}`)
        );
        check(samples.length >= WATCH_SECONDS, `received ${samples.length} notifications`);
        if (samples.length >= 2) {
            const e0 = Math.abs(NEW_TEMP_SP - samples[0]);
            const e1 = Math.abs(NEW_TEMP_SP - samples[samples.length - 1]);
            check(e1 < e0, `PV approaches SP (|error| ${fmt(e0)} -> ${fmt(e1)})`);
        }

        // ------------------------------------------------------------------
        console.log("\n[5] Running = false -> Speed falls to 0");
        const speedBefore = (await session.read({ nodeId: id("Speed.PV") })).value.value;
        sc = await session.write({
            nodeId: id("Running"),
            attributeId: AttributeIds.Value,
            value: { value: { dataType: DataType.Boolean, value: false } }
        });
        check(sc === StatusCodes.Good, `Running = false accepted (${sc.name})`);
        await sleep(5000);
        const speedStopped = (await session.read({ nodeId: id("Speed.PV") })).value.value;
        const spAfterStop = (await session.read({ nodeId: id("Speed.SP") })).value.value;
        console.log(`  Speed.PV ${fmt(speedBefore)} -> ${fmt(speedStopped)} rpm after 5 s`);
        check(speedStopped < speedBefore * 0.2, "Speed dropped substantially");
        check(spAfterStop === config.machine.tags.Speed.defaultSP, `Speed.SP unchanged (${spAfterStop})`);

        await session.write({
            nodeId: id("Running"),
            attributeId: AttributeIds.Value,
            value: { value: { dataType: DataType.Boolean, value: true } }
        });
        await sleep(3000);
        const speedRestart = (await session.read({ nodeId: id("Speed.PV") })).value.value;
        console.log(`  Running = true, Speed.PV after 3 s = ${fmt(speedRestart)} rpm`);
        check(speedRestart > speedStopped, "Speed rises again after restart");

        // Vrátit výchozí SP, ať server zůstane v původním stavu
        await writeDouble(session, id("Temperature.SP"), config.machine.tags.Temperature.defaultSP);
    } finally {
        await session.close();
        await client.disconnect();
    }

    console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
}

async function writeDouble(session, nodeId, value) {
    return session.write({
        nodeId,
        attributeId: AttributeIds.Value,
        value: { value: { dataType: DataType.Double, value } }
    });
}

/** Přečte vlastnosti EURange a EngineeringUnits analogové proměnné. */
async function readAnalogProps(session, nodeId) {
    const results = await session.translateBrowsePath([
        makeBrowsePath(nodeId, ".EURange"),
        makeBrowsePath(nodeId, ".EngineeringUnits")
    ]);
    const [rangeId, unitId] = results.map((r) => r.targets[0].targetId);
    const [range, unit] = await session.read([{ nodeId: rangeId }, { nodeId: unitId }]);
    return {
        range: range.value.value,
        unit: unit.value.value.displayName.text
    };
}

/** Subscription na jeden uzel; vrací seznam přijatých hodnot. */
async function watch(session, nodeId, durationMs, onValue) {
    const subscription = await session.createSubscription2({
        requestedPublishingInterval: 500,
        requestedLifetimeCount: 100,
        requestedMaxKeepAliveCount: 10,
        maxNotificationsPerPublish: 100,
        publishingEnabled: true,
        priority: 10
    });
    const item = ClientMonitoredItem.create(
        subscription,
        { nodeId, attributeId: AttributeIds.Value },
        { samplingInterval: 500, discardOldest: true, queueSize: 10 },
        TimestampsToReturn.Both
    );
    const values = [];
    const t0 = Date.now();
    item.on("changed", (dv) => {
        values.push(dv.value.value);
        onValue(dv.value.value, (Date.now() - t0) / 1000);
    });
    await sleep(durationMs);
    await subscription.terminate();
    return values;
}

const fmt = (v) => (typeof v === "number" ? v.toFixed(2) : String(v));

main().catch((err) => {
    console.error("Test failed with error:", err);
    process.exit(1);
});
