"use strict";
/**
 * Vstupní bod: spustí simulaci stroje a OPC UA server, Ctrl+C = čisté ukončení.
 */
const config = require("../config");
const { Machine } = require("./machine");
const { MachineServer } = require("./server");

async function main() {
    const machine = new Machine(config.machine, config.simulation);
    const server = new MachineServer(config, machine);

    await server.start();
    machine.start();

    console.log("");
    console.log("OPC UA Machine Simulator is running");
    console.log(`  Endpoint:   ${server.endpointUrl}`);
    console.log(`  Security:   None, anonymous`);
    console.log(`  Namespace:  ${config.server.namespaceUri} (ns=${server.namespaceIndex})`);
    console.log(`  Update:     every ${config.simulation.updateIntervalMs} ms`);
    console.log("  NodeIds:");
    for (const id of server.nodeIds) {
        console.log(`    ns=${server.namespaceIndex};s=${id}`);
    }
    console.log("");
    console.log("Press Ctrl+C to stop.");
    console.log("");

    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        console.log(`\n${signal} received, shutting down...`);
        machine.stop();
        try {
            await server.stop();
            console.log("Server stopped.");
            process.exit(0);
        } catch (err) {
            console.error("Error during shutdown:", err);
            process.exit(1);
        }
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
});
