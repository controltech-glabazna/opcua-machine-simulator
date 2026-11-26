# OPC UA simulátor stroje

Node.js aplikace, která na localhostu spouští OPC UA server simulující jednoduchý stroj
(teplota, tlak, otáčky, běh). Slouží k testování a jako datový zdroj pro další aplikace.

## Požadavky

- Node.js 20 LTS (ověřeno na 20.17) nebo novější
- Knihovna `node-opcua` je zafixovaná na verzi **2.163.1**. Novější verze (od 2.164) používají
  čistě ESM závislost `hexy@0.4`, kterou Node starší než 20.19 nenačte (`ERR_REQUIRE_ESM`).
  S Node ≥ 20.19 / 22 LTS lze node-opcua aktualizovat (`npm install node-opcua@latest`).

## Instalace a spuštění

```bash
npm install
npm start
```

Server vypíše endpoint a seznam NodeId. Ukončení: **Ctrl+C**.

| Parametr  | Hodnota                                         |
|-----------|-------------------------------------------------|
| Endpoint  | `opc.tcp://localhost:4860/UA/MachineSimulator`  |
| Security  | None (Security Mode None, Policy None)          |
| Přihlášení| Anonymous                                       |
| Namespace | `urn:controltech:machine-simulator` (obvykle `ns=2`) |

Port je **4860**, protože standardní OPC UA port 4840 bývá obsazený systémovou službou
(např. Local Discovery Server). Změnit ho lze v `config.js` (`server.port`).
Testovací klient čte port ze stejného souboru.

## Struktura projektu

```
config.js             konfigurace: port, cesta, interval, rozsahy, dynamika tagů
src/index.js          vstupní bod, výpis do konzole, čisté ukončení (Ctrl+C)
src/machine.js        model stroje – simulace 1. řádu + šum, bez závislosti na OPC UA
src/server.js         OPC UA server – adresní prostor, validace a logování zápisů
test/client-test.js   testovací OPC UA klient
```

## Adresní prostor a tagy

```
Objects/
  Machine1/
    Temperature/ PV, SP
    Pressure/    PV, SP
    Speed/       PV, SP
    Running
```

| NodeId                              | Typ     | Přístup | Jednotka | Rozsah  | Výchozí |
|-------------------------------------|---------|---------|----------|---------|---------|
| `ns=2;s=Machine1.Temperature.PV`    | Double  | R       | °C       | 0–150   | –       |
| `ns=2;s=Machine1.Temperature.SP`    | Double  | R/W     | °C       | 0–150   | 60      |
| `ns=2;s=Machine1.Pressure.PV`       | Double  | R       | bar      | 0–10    | –       |
| `ns=2;s=Machine1.Pressure.SP`       | Double  | R/W     | bar      | 0–10    | 4,0     |
| `ns=2;s=Machine1.Speed.PV`          | Double  | R       | r/min    | 0–3000  | –       |
| `ns=2;s=Machine1.Speed.SP`          | Double  | R/W     | r/min    | 0–3000  | 1500    |
| `ns=2;s=Machine1.Running`           | Boolean | R/W     | –        | –       | true    |

Každá PV i SP je `AnalogItemType` s vlastnostmi `EngineeringUnits` a `EURange`.
Index namespace (`ns=2`) přiděluje server při startu. Klient by si ho měl zjistit
z `NamespaceArray` podle URI.

## Chování simulace

- PV se přepočítává každých 500 ms (`config.simulation.updateIntervalMs`).
- PV sleduje SP jako soustava 1. řádu (Temperature τ ≈ 20 s, Pressure 5 s, Speed 2 s) + šum
  (±0,3 °C, ±0,05 bar, ±10 rpm).
- `Running = false`: Speed → 0, Pressure → 0, Temperature chladne k 20 °C (τ 60 s). SP se nemění.
- `Running = true`: PV se vrací k SP.
- PV nikdy neopustí svůj rozsah.
- Zápis SP mimo rozsah → `BadOutOfRange` (hodnota se nezmění), zápis do PV → `BadNotWritable`.
- Subscriptions: PV posílá změny při každém kroku simulace, SP a Running se vzorkují (min. 100 ms).
- Každý zápis z klienta (úspěšný i odmítnutý) se loguje do konzole:
  ```
  WRITE OK     Machine1.Temperature.SP = 80 (Double) by session "client-test1", ::1:59655, user anonymous
  WRITE REJECT Machine1.Temperature.SP = 200 (Double) by session "client-test1", ::1:59655, user anonymous -> BadOutOfRange
  ```

## Testovací klient

Se spuštěným serverem v druhém terminálu:

```bash
npm test                       # sledování PV 15 s
node test/client-test.js 30    # sledování PV 30 s
```

Test přečte všechny tagy včetně jednotek a rozsahů. Zapíše `Temperature.SP = 80` a ověří, že server
odmítne zápis mimo rozsah i zápis do PV. Přes subscription pak sleduje, jak se `Temperature.PV`
blíží k SP. Nakonec vyzkouší `Running = false/true` a vrátí SP na výchozí hodnotu.
Při chybě skončí s exit kódem 1.

## Test v UaExpert

1. Spusť server (`npm start`).
2. V UaExpert: **Server → Add…** → záložka *Advanced*, Endpoint URL
   `opc.tcp://localhost:4860/UA/MachineSimulator`, Security Policy **None**,
   Message Security Mode **None**, Authentication **Anonymous** → OK.
   Případně v *Custom Discovery* zadej `opc.tcp://localhost:4860` a vyber endpoint *None*.
3. **Connect**. Při dotazu na certifikát serveru zvol *Trust Server Certificate*.
4. V *Address Space* rozbal `Objects → Machine1` a přetáhni PV/SP/Running do *Data Access View*.
   Hodnoty se aktualizují přes subscription.
5. Zápis: dvojklik do sloupce *Value* u `Temperature.SP`, zadej např. 90 → PV začne stoupat.
   Hodnota 200 je odmítnuta (`BadOutOfRange`), hodnota se nezmění, v konzoli serveru je `WRITE REJECT`.
6. `Running` přepni na `false` → Speed a Pressure klesnou k 0, teplota pomalu chladne k 20 °C.
7. U PV/SP vybraného uzlu jsou v *Attributes*/*References* vidět vlastnosti `EURange` a `EngineeringUnits`.

## Konfigurace

Vše v `config.js`: port, cesta endpointu, URI namespace, interval aktualizace, teplota okolí
a pro každý tag jednotka (klíč z `standardUnits` v node-opcua), rozsah, výchozí SP, šum,
časová konstanta a chování po zastavení.

## Poznámky

- Při startu node-opcua vytvoří vlastní PKI/certifikát aplikace v uživatelském profilu.
  První start proto trvá déle.
- Varování `NODE-OPCUA-W27 ... CVE-2023-46809` lze při Security None ignorovat.
- Zabezpečení je vypnuté. Server je určený pouze pro vývojové prostředí.
