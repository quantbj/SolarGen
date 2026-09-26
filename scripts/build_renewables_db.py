#!/usr/bin/env python3
"""Build the renewable-electricity district database and app payload.

Consistent county-level generation data for 2025 is not fully public yet. This
builder therefore uses 2024, stores the source catalogue, official
district/population data, and a transparent regionalisation model scaled to
published 2024 national generation totals. Regional benchmarks replace model
values where reliable county-level sources are available.
"""

from __future__ import annotations

import json
import math
import sqlite3
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
PROCESSED_DIR = ROOT / "data" / "processed"
PUBLIC_DIR = ROOT / "public" / "renewables"
DB_PATH = ROOT / "data" / "renewables_2024.sqlite3"
DATA_YEAR = 2024

BKG_URL = (
    "https://sgx.geodatenzentrum.de/wfs_vg250?"
    "SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=vg250:vg250_krs"
    "&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326"
)
DESTATIS_GV_URL = (
    "https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/"
    "Gemeindeverzeichnis/Administrativ/Archiv/GVAuszugQ/"
    "AuszugGV4QAktuell.xlsx?__blob=publicationFile&v=18"
)
OSNABRUECK_2024_URL = "https://www.landkreis-osnabrueck.de/sites/default/files/2026-04/daten-ee-strom-2024.xlsx"

NATIONAL_GENERATION_GWH = {
    "solar": 59700,
    "wind": 136300,
    "biomass": 36200,
    "water": 20400,
}

SOURCE_NAMES_DE = {
    "solar": "Solar",
    "wind": "Wind",
    "biomass": "Biomasse",
    "water": "Wasser",
}

STATE_NAMES = {
    "01": "Schleswig-Holstein",
    "02": "Hamburg",
    "03": "Niedersachsen",
    "04": "Bremen",
    "05": "Nordrhein-Westfalen",
    "06": "Hessen",
    "07": "Rheinland-Pfalz",
    "08": "Baden-Württemberg",
    "09": "Bayern",
    "10": "Saarland",
    "11": "Berlin",
    "12": "Brandenburg",
    "13": "Mecklenburg-Vorpommern",
    "14": "Sachsen",
    "15": "Sachsen-Anhalt",
    "16": "Thüringen",
}

WIND_STATE_FACTOR = {
    "01": 2.3, "02": 0.2, "03": 1.9, "04": 0.3,
    "05": 0.9, "06": 0.8, "07": 1.0, "08": 0.6,
    "09": 0.7, "10": 0.5, "11": 0.1, "12": 1.8,
    "13": 2.1, "14": 1.0, "15": 1.7, "16": 1.2,
}

WATER_STATE_FACTOR = {
    "01": 0.1, "02": 0.1, "03": 0.2, "04": 0.1,
    "05": 0.6, "06": 0.8, "07": 1.2, "08": 2.6,
    "09": 3.2, "10": 0.5, "11": 0.1, "12": 0.2,
    "13": 0.2, "14": 0.9, "15": 0.4, "16": 0.7,
}

REGIONAL_OVERRIDES_GWH = {
    "11000": {
        "solar": {
            "value": 343,
            "source_id": "berlin-solarcity-2024",
            "note": "Berlin: 380,7 MWp installierte PV-Leistung Ende 2024 × 900 Vollbenutzungsstunden = rund 343 GWh Solarstrom.",
        }
    },
}

NATIONAL_SOURCE_IDS = {
    "solar": "destatis-electricity-2024",
    "wind": "destatis-electricity-2024",
    "biomass": "bnetza-smard-2024-comparison",
    "water": "destatis-electricity-2024",
}

SOURCE_CATALOG = [
    (
        "destatis-electricity-2024",
        "Destatis Stromerzeugung 2024 aus Pressemitteilung Nr. 073/2026",
        "https://www.destatis.de/DE/Presse/Pressemitteilungen/2026/03/PD26_073_43312.html",
        "2026-03-06",
        "Endgültige nationale Netzeinspeisung 2024 für Windkraft, Photovoltaik, Biogas und Wasserkraft; Basis für das konsistentere Kartenjahr 2024.",
        "official-national",
    ),
    (
        "bnetza-smard-2024-comparison",
        "Bundesnetzagentur SMARD: Jahresvergleich 2024/2025",
        "https://www.bundesnetzagentur.de/SharedDocs/Pressemitteilungen/DE/2026/20260105_Smard.html",
        "2026-01-05",
        "Nationale Biomasse-Nettostromerzeugung 2024 aus der SMARD-Jahresvergleichstabelle; verwendet, weil Destatis in der Pressemitteilung nur Biogas ausweist.",
        "official-national",
    ),
    (
        "mastr-export-2026-01-01",
        "Marktstammdatenregister Gesamtdatenexport Stichtag 01.01.2026",
        "https://download.marktstammdatenregister.de/Stichtag/Gesamtdatenexport_20260101_25.2.zip",
        "2026-01-01",
        "Amtliche Anlagenstammdaten für Standort und installierte Leistung; 2,8-GB-Gesamtexport, nicht gebündelt.",
        "official-plant-master-data",
    ),
    (
        "netztransparenz-eeg",
        "Netztransparenz EEG-Jahresabrechnungen und Bewegungsdaten",
        "https://www.netztransparenz.de/de-de/Erneuerbare-Energien-und-Umlagen/EEG/EEG-Abrechnungen/EEG-Jahresabrechnungen",
        "2025-09-30",
        "Jüngste sichtbare detaillierte EEG-Jahresbewegungsdaten sind 2024; 2025 wird später im Jahr 2026 erwartet.",
        "official-movement-data-pending",
    ),
    (
        "destatis-gv-2025q4",
        "Destatis GV-ISys Quartalsausgabe 31.12.2025",
        "https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/_inhalt.html",
        "2026-06-07",
        "Amtliche Kreisschlüssel und Bevölkerungsbasis. Die Datei trägt aktuell Einwohnerwerte zum 31.12.2024 auf Gebietsstand 31.12.2025.",
        "official-demography",
    ),
    (
        "bkg-vg250-krs",
        "BKG Verwaltungsgebiete VG250 Kreise WFS",
        "https://sgx.geodatenzentrum.de/wfs_vg250",
        "2026-06-07",
        "Amtliche Kreisgeometrien für die interaktive Karte.",
        "official-geometry",
    ),
    (
        "berlin-solarcity-2024",
        "Monitoringbericht Solarcity Berlin 2024",
        "https://www.berliner-e-agentur.de/presse/monitoringbericht-2024-veroeffentlicht-sonnige-bilanz-fuer-den-berliner-solarausbau",
        "2025-05-14",
        "Berlin-spezifischer Plausibilitätsanker: 380,7 MWp installierte PV-Leistung Ende 2024; mit 900 Vollbenutzungsstunden rund 343 GWh Solarstrom.",
        "official-regional-benchmark",
    ),
    (
        "lkos-ee-2024",
        "Landkreis Osnabrück: EEG-Anlagen und Netzeinspeisung 2024",
        "https://www.landkreis-osnabrueck.de/fachthemen/klima-und-energie/klimaschutzkonzepte-und-statistiken",
        "2026-04",
        "Direkte 2024-Netzeinspeisung im Landkreis Osnabrück nach Wind, Wasser, Biomasse und Photovoltaik.",
        "official-regional-benchmark",
    ),
]


def ensure_dirs() -> None:
    for path in (RAW_DIR, PROCESSED_DIR, PUBLIC_DIR):
        path.mkdir(parents=True, exist_ok=True)


def download_if_missing(url: str, path: Path) -> None:
    if path.exists() and path.stat().st_size > 0:
        return
    with urllib.request.urlopen(url, timeout=60) as response:
        path.write_bytes(response.read())


def parse_xlsx_rows(path: Path, sheet_name: str):
    ns = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with ZipFile(path) as workbook:
        shared_strings = []
        root = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
        for item in root.findall("a:si", ns):
            shared_strings.append("".join(t.text or "" for t in item.findall(".//a:t", ns)))

        sheet = ET.fromstring(workbook.read(sheet_name))
        for row in sheet.findall(".//a:row", ns):
            values = {}
            for cell in row.findall("a:c", ns):
                col = "".join(ch for ch in cell.get("r", "") if ch.isalpha())
                value_node = cell.find("a:v", ns)
                value = "" if value_node is None else value_node.text or ""
                if cell.get("t") == "s" and value:
                    value = shared_strings[int(value)]
                values[col] = value
            yield values


def parse_population(path: Path) -> dict[str, dict]:
    districts = defaultdict(lambda: {"population": 0, "area_km2": 0.0, "municipalities": 0})
    for row in parse_xlsx_rows(path, "xl/worksheets/sheet2.xml"):
        if row.get("A") != "60":
            continue
        ags = f"{row.get('C', '')}{row.get('D', '')}{row.get('E', '')}".zfill(5)
        districts[ags]["population"] += int(float(row.get("J") or 0))
        districts[ags]["area_km2"] += float(row.get("I") or 0)
        districts[ags]["municipalities"] += 1
    return dict(districts)


def parse_osnabrueck_2024(path: Path) -> dict[str, dict]:
    for row in parse_xlsx_rows(path, "xl/worksheets/sheet1.xml"):
        if row.get("B") != "Summe":
            continue
        return {
            "wind": {
                "value": float(row["H"]) / 1000,
                "source_id": "lkos-ee-2024",
                "note": "Landkreis Osnabrück: direkte Netzeinspeisung 2024 aus der Summenzeile des veröffentlichten EEG-Anlagen-Anhangs.",
            },
            "water": {
                "value": float(row["K"]) / 1000,
                "source_id": "lkos-ee-2024",
                "note": "Landkreis Osnabrück: direkte Netzeinspeisung 2024 aus der Summenzeile des veröffentlichten EEG-Anlagen-Anhangs.",
            },
            "biomass": {
                "value": float(row["N"]) / 1000,
                "source_id": "lkos-ee-2024",
                "note": "Landkreis Osnabrück: direkte Netzeinspeisung 2024 aus der Summenzeile des veröffentlichten EEG-Anlagen-Anhangs.",
            },
            "solar": {
                "value": float(row["T"]) / 1000,
                "source_id": "lkos-ee-2024",
                "note": "Landkreis Osnabrück: direkte PV-Netzeinspeisung 2024 aus der Summenzeile des veröffentlichten EEG-Anlagen-Anhangs.",
            },
        }
    raise ValueError(f"Keine Summenzeile in {path} gefunden")


def build_regional_overrides(osnabrueck_path: Path) -> dict[str, dict]:
    overrides = {
        ags: {source: values.copy() for source, values in source_values.items()}
        for ags, source_values in REGIONAL_OVERRIDES_GWH.items()
    }
    overrides["03459"] = parse_osnabrueck_2024(osnabrueck_path)
    return overrides


def full_name(props: dict) -> str:
    bez = props.get("bez", "")
    gen = props.get("gen", "")
    if bez in {"Kreisfreie Stadt", "Stadtkreis"}:
        return gen
    return f"{bez} {gen}".strip()


def build_districts(geojson: dict, population: dict[str, dict]) -> list[dict]:
    by_ags = {}
    for feature in geojson["features"]:
        props = feature["properties"]
        ags = props["ags"]
        if ags not in population:
            continue
        if ags in by_ags:
            continue
        pop = population[ags]
        area = pop["area_km2"]
        people = pop["population"]
        density = people / area if area else 0
        by_ags[ags] = {
            "ags": ags,
            "name": full_name(props),
            "short_name": props.get("gen", ""),
            "district_type": props.get("bez", ""),
            "state_code": ags[:2],
            "state_name": STATE_NAMES.get(ags[:2], ags[:2]),
            "nuts": props.get("nuts", ""),
            "population": people,
            "area_km2": area,
            "density": density,
            "municipalities": pop["municipalities"],
        }
    return sorted(by_ags.values(), key=lambda item: item["ags"])


def source_weights(district: dict) -> dict[str, float]:
    area = max(district["area_km2"], 0.1)
    population = max(district["population"], 1)
    density = population / area
    state = district["state_code"]

    rural = min(2.6, max(0.2, 450 / max(density, 20)))
    urban = min(2.2, max(0.35, density / 350))
    latitude_factor = 1.08 if state in {"08", "09", "10", "07"} else 1.0
    if state in {"12", "13", "14", "15", "16"}:
        latitude_factor = 1.03

    solar = (0.62 * population + 185 * area) * latitude_factor
    wind = area * WIND_STATE_FACTOR.get(state, 1.0) * rural
    biomass = area * rural * (1.0 + 0.12 * math.log1p(population / 100000))
    water = area * WATER_STATE_FACTOR.get(state, 0.6) * (0.55 + 0.45 * rural)

    # Small city correction: dense districts still have rooftop PV but less wind/biomass.
    if density > 1200:
        wind *= 0.22
        biomass *= 0.45
        water *= 0.55
        solar *= 0.9 + 0.08 * min(urban, 2.0)

    return {"solar": solar, "wind": wind, "biomass": biomass, "water": water}


def audit_note(district: dict, source_values: dict[str, float], overrides: dict[str, dict]) -> str:
    ags = district["ags"]
    if ags in overrides and len(overrides[ags]) == len(NATIONAL_GENERATION_GWH):
        return "Alle vier Quellen wurden aus einer veröffentlichten Kreisquelle übernommen."
    if ags in overrides:
        sources = ", ".join(SOURCE_NAMES_DE[source] for source in sorted(overrides[ags]))
        return f"{sources} ersetzt den Modellwert; übrige Quellen sind modelliert."

    total = sum(source_values.values())
    per_capita = total * 1_000_000 / district["population"] if district["population"] else 0
    share_parts = {
        source: value / total if total else 0
        for source, value in source_values.items()
    }
    dominant_source, dominant_share = max(share_parts.items(), key=lambda item: item[1])
    notes = ["Modellwert: kein flächendeckend importierter Landkreis-Bewegungsdatensatz für diesen Kreis."]
    if per_capita > 12000:
        notes.append("Hoher Pro-Einwohner-Wert; typischer Effekt dünn besiedelter Wind-/Biomassekreise.")
    if dominant_share > 0.9:
        notes.append(f"Sehr starke Dominanz von {SOURCE_NAMES_DE[dominant_source]}; sollte bei lokaler Weiterverwendung geprüft werden.")
    if district["density"] > 1200 and (source_values["wind"] + source_values["biomass"]) > source_values["solar"]:
        notes.append("Stadtkreis mit modelliertem Wind-/Biomasseanteil; regionale Anlagen-/Einspeisedaten wären vorzuziehen.")
    return " ".join(notes)


def build_generation(districts: list[dict], overrides: dict[str, dict]) -> list[dict]:
    raw_weights = {district["ags"]: source_weights(district) for district in districts}
    fixed_by_source = {
        source: sum(source_values[source]["value"] for source_values in overrides.values() if source in source_values)
        for source in NATIONAL_GENERATION_GWH
    }
    weight_totals = {}
    for source in NATIONAL_GENERATION_GWH:
        weight_totals[source] = sum(
            weights[source]
            for ags, weights in raw_weights.items()
            if source not in overrides.get(ags, {})
        )
    rows = []
    for district in districts:
        ags = district["ags"]
        source_values = {}
        for source in NATIONAL_GENERATION_GWH:
            if source in overrides.get(ags, {}):
                source_values[source] = overrides[ags][source]["value"]
            else:
                remaining = NATIONAL_GENERATION_GWH[source] - fixed_by_source[source]
                source_values[source] = remaining * raw_weights[ags][source] / weight_totals[source]
        total = sum(source_values.values())
        per_capita = total * 1_000_000 / district["population"] if district["population"] else 0
        quality = "regional belegt" if ags in overrides and len(overrides[ags]) == len(NATIONAL_GENERATION_GWH) else "teilweise belegt" if ags in overrides else "modelliert"
        row = {
            "ags": ags,
            "year": DATA_YEAR,
            "solar_gwh": source_values["solar"],
            "wind_gwh": source_values["wind"],
            "biomass_gwh": source_values["biomass"],
            "water_gwh": source_values["water"],
            "total_gwh": total,
            "kwh_per_capita": per_capita,
            "method": "Regionalisierungsmodell, skaliert auf nationale 2024-Summen; regionale Quellen ersetzen den Modellwert je Energieträger.",
            "quality": quality,
            "audit_note": audit_note(district, source_values, overrides),
        }
        rows.append(row)
    return rows


def simplify_geojson(geojson: dict, districts_by_ags: dict[str, dict], generation_by_ags: dict[str, dict]) -> dict:
    features = []
    for feature in geojson["features"]:
        ags = feature["properties"]["ags"]
        if ags not in districts_by_ags:
            continue
        district = districts_by_ags[ags]
        generation = generation_by_ags[ags]
        feature["properties"] = {
            "ags": ags,
            "name": district["name"],
            "state": district["state_name"],
            "population": district["population"],
            "area_km2": round(district["area_km2"], 2),
            "total_gwh": round(generation["total_gwh"], 3),
            "kwh_per_capita": round(generation["kwh_per_capita"], 1),
            "solar_gwh": round(generation["solar_gwh"], 3),
            "wind_gwh": round(generation["wind_gwh"], 3),
            "biomass_gwh": round(generation["biomass_gwh"], 3),
            "water_gwh": round(generation["water_gwh"], 3),
            "quality": generation["quality"],
            "audit_note": generation["audit_note"],
        }
        features.append(feature)
    return {"type": "FeatureCollection", "features": features}


def benchmark_rows(overrides: dict[str, dict]) -> list[tuple]:
    rows = []
    for ags, source_values in overrides.items():
        for source, item in source_values.items():
            rows.append((ags, source, item["value"], item["source_id"], item["note"]))
    return rows


def write_database(districts: list[dict], generation: list[dict], overrides: dict[str, dict]) -> None:
    if DB_PATH.exists():
        DB_PATH.unlink()
    con = sqlite3.connect(DB_PATH)
    try:
        con.executescript(
            """
            CREATE TABLE source_catalog (
              source_id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              url TEXT NOT NULL,
              retrieved_or_published_date TEXT,
              notes TEXT,
              source_type TEXT NOT NULL
            );

            CREATE TABLE districts (
              ags TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              short_name TEXT NOT NULL,
              district_type TEXT NOT NULL,
              state_code TEXT NOT NULL,
              state_name TEXT NOT NULL,
              nuts TEXT,
              population INTEGER NOT NULL,
              area_km2 REAL NOT NULL,
              density REAL NOT NULL,
              municipalities INTEGER NOT NULL
            );

            CREATE TABLE national_generation_2024 (
              source TEXT PRIMARY KEY,
              gwh REAL NOT NULL,
              source_id TEXT NOT NULL REFERENCES source_catalog(source_id)
            );

            CREATE TABLE regional_benchmarks (
              ags TEXT NOT NULL REFERENCES districts(ags),
              source TEXT NOT NULL,
              value_gwh REAL NOT NULL,
              source_id TEXT NOT NULL REFERENCES source_catalog(source_id),
              note TEXT NOT NULL,
              PRIMARY KEY (ags, source)
            );

            CREATE TABLE district_generation_2024 (
              ags TEXT PRIMARY KEY REFERENCES districts(ags),
              year INTEGER NOT NULL,
              solar_gwh REAL NOT NULL,
              wind_gwh REAL NOT NULL,
              biomass_gwh REAL NOT NULL,
              water_gwh REAL NOT NULL,
              total_gwh REAL NOT NULL,
              kwh_per_capita REAL NOT NULL,
              method TEXT NOT NULL,
              quality TEXT NOT NULL,
              audit_note TEXT NOT NULL
            );

            CREATE VIEW district_generation_summary AS
            SELECT
              d.ags,
              d.name,
              d.district_type,
              d.state_name,
              d.population,
              d.area_km2,
              g.solar_gwh,
              g.wind_gwh,
              g.biomass_gwh,
              g.water_gwh,
              g.total_gwh,
              g.kwh_per_capita,
              g.method,
              g.quality,
              g.audit_note
            FROM districts d
            JOIN district_generation_2024 g ON g.ags = d.ags;
            """
        )
        con.executemany("INSERT INTO source_catalog VALUES (?, ?, ?, ?, ?, ?)", SOURCE_CATALOG)
        con.executemany(
            """
            INSERT INTO districts (
              ags, name, short_name, district_type, state_code, state_name, nuts,
              population, area_km2, density, municipalities
            ) VALUES (
              :ags, :name, :short_name, :district_type, :state_code, :state_name, :nuts,
              :population, :area_km2, :density, :municipalities
            )
            """,
            districts,
        )
        con.executemany(
            "INSERT INTO national_generation_2024 VALUES (?, ?, ?)",
            [
                (source, NATIONAL_GENERATION_GWH[source], NATIONAL_SOURCE_IDS[source])
                for source in NATIONAL_GENERATION_GWH
            ],
        )
        con.executemany(
            "INSERT INTO regional_benchmarks VALUES (?, ?, ?, ?, ?)",
            benchmark_rows(overrides),
        )
        con.executemany(
            """
            INSERT INTO district_generation_2024 (
              ags, year, solar_gwh, wind_gwh, biomass_gwh, water_gwh,
              total_gwh, kwh_per_capita, method, quality, audit_note
            ) VALUES (
              :ags, :year, :solar_gwh, :wind_gwh, :biomass_gwh, :water_gwh,
              :total_gwh, :kwh_per_capita, :method, :quality, :audit_note
            )
            """,
            generation,
        )
        con.commit()
    finally:
        con.close()


def main() -> None:
    ensure_dirs()
    geojson_path = RAW_DIR / "bkg_vg250_krs.geojson"
    gv_path = RAW_DIR / "destatis_gv_2025q4.xlsx"
    osnabrueck_path = RAW_DIR / "osnabrueck_ee_strom_2024.xlsx"
    download_if_missing(BKG_URL, geojson_path)
    download_if_missing(DESTATIS_GV_URL, gv_path)
    download_if_missing(OSNABRUECK_2024_URL, osnabrueck_path)

    geojson = json.loads(geojson_path.read_text(encoding="utf-8"))
    population = parse_population(gv_path)
    districts = build_districts(geojson, population)
    overrides = build_regional_overrides(osnabrueck_path)
    generation = build_generation(districts, overrides)
    districts_by_ags = {district["ags"]: district for district in districts}
    generation_by_ags = {row["ags"]: row for row in generation}

    write_database(districts, generation, overrides)

    payload = {
        "metadata": {
            "title": "Erneuerbare Stromerzeugung 2024 nach Landkreis",
            "status": "Regionalisiertes 2024-Modell mit Plausibilitätsaudit",
            "year": DATA_YEAR,
            "district_count": len(districts),
            "population_basis": "Destatis GV-ISys Gebietsstand 31.12.2025, Einwohnerwerte in der Quelldatei als 31.12.2024 gekennzeichnet.",
            "method": "Nationale 2024-Quellensummen werden über transparente geografische/demografische Proxy-Gewichte auf Kreise verteilt. Wo belastbare regionale Quellen vorliegen, ersetzen diese den Proxywert je Energieträger.",
            "warning": "2025 wird bewusst nicht verwendet: konsistente Landkreis-Bewegungsdaten sind am 07.06.2026 noch nicht flächendeckend veröffentlicht. 2024 ist als Kartenjahr belastbarer.",
            "data_audit": "Kritische Prüfung aller Kreise: Osnabrück ist vollständig mit regionaler 2024-Netzeinspeisung ersetzt; Berlin Solar ist mit 380,7 MWp × 900 Vollbenutzungsstunden = rund 343 GWh plausibilisiert. Alle anderen Kreise bleiben modelliert und tragen eine Audit-Notiz statt amtlicher Kreisgenauigkeit.",
            "national_generation_gwh": NATIONAL_GENERATION_GWH,
            "regional_benchmarks": overrides,
            "quality_counts": dict(Counter(row["quality"] for row in generation)),
            "sources": [
                {
                    "source_id": row[0],
                    "title": row[1],
                    "url": row[2],
                    "date": row[3],
                    "notes": row[4],
                    "source_type": row[5],
                }
                for row in SOURCE_CATALOG
            ],
        },
        "districts": districts,
        "generation": generation,
    }
    (PROCESSED_DIR / "renewables_2024.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (PUBLIC_DIR / "districts.geojson").write_text(
        json.dumps(simplify_geojson(geojson, districts_by_ags, generation_by_ags), ensure_ascii=False),
        encoding="utf-8",
    )
    (PUBLIC_DIR / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Wrote {DB_PATH}")
    print(f"Wrote {PUBLIC_DIR / 'summary.json'}")
    print(f"Wrote {PUBLIC_DIR / 'districts.geojson'}")


if __name__ == "__main__":
    main()
