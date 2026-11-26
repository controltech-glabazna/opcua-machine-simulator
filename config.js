"use strict";
/**
 * Konfigurace OPC UA simulátoru stroje.
 * Vše, co je potřeba ladit (port, interval, rozsahy, dynamika), je zde.
 */
module.exports = {
    server: {
        port: 4840,
        resourcePath: "/UA/MachineSimulator",
        namespaceUri: "urn:controltech:machine-simulator",
        productName: "MachineSimulator",
        applicationName: "OPC UA Machine Simulator"
    },

    simulation: {
        // Perioda výpočtu nových PV [ms]
        updateIntervalMs: 500,
        // Teplota okolí, ke které stroj chladne po zastavení [°C]
        ambientTemperature: 20,
        // Výchozí stav Running
        initialRunning: true
    },

    machine: {
        name: "Machine1",
        // Klíč = jméno složky v adresním prostoru (Machine1.<klíč>.PV / .SP)
        tags: {
            Temperature: {
                unit: "degree_celsius",   // klíč v node-opcua standardUnits
                range: { low: 0, high: 150 },
                defaultSP: 60,
                noise: 0.3,               // amplituda šumu (±)
                timeConstantSec: 20,      // časová konstanta při běhu
                // Chování při Running = false
                stopped: { target: "ambient", timeConstantSec: 60, noise: true }
            },
            Pressure: {
                unit: "bar",
                range: { low: 0, high: 10 },
                defaultSP: 4.0,
                noise: 0.05,
                timeConstantSec: 5,
                stopped: { target: 0, timeConstantSec: 5, noise: false }
            },
            Speed: {
                unit: "revolutions_per_minute",
                range: { low: 0, high: 3000 },
                defaultSP: 1500,
                noise: 10,
                timeConstantSec: 2,
                stopped: { target: 0, timeConstantSec: 2, noise: false }
            }
        }
    }
};
