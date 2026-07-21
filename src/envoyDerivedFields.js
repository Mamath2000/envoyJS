/**
 * Calcule les champs derives (grid/eco/courant/lifetime) a partir des champs
 * bruts normalises d'Envoy, en appliquant une correction optionnelle (ex:
 * tableau electrique deporte). Fonction pure, un seul passage de calcul.
 */
export function deriveEnvoyFields(rawFields, correction = {}) {
  if (!rawFields || typeof rawFields !== "object") return rawFields;

  const signedPowerW = Number(correction.signedPowerW ?? 0);
  const energyOffsetWh = Number(correction.energyOffsetWh ?? 0);

  const adjusted = { ...rawFields };

  const baseNetPowerW = Number(adjusted.conso_net_eim_wNow ?? 0);
  if (Number.isFinite(baseNetPowerW)) {
    const correctedNetPowerW = Math.round(baseNetPowerW + signedPowerW);
    adjusted.conso_net_eim_wNow = correctedNetPowerW;

    adjusted.grid_eim_wNow = correctedNetPowerW < 0 ? Math.abs(correctedNetPowerW) : 0;
    adjusted.grid_eim_wNow_binary = correctedNetPowerW > 0 ? 1 : 0;

    const prodW = Number(adjusted.prod_eim_wNow);
    if (Number.isFinite(prodW)) {
      adjusted.eco_eim_wNow = correctedNetPowerW < 0 ? prodW + correctedNetPowerW : prodW;
    }

    // Coherence electrique demandee: I = P / U
    const netVoltageV = Number(adjusted.conso_net_eim_voltage);
    if (Number.isFinite(netVoltageV) && Math.abs(netVoltageV) > 0.1) {
      adjusted.conso_net_eim_current = Number((correctedNetPowerW / netVoltageV).toFixed(3));
    }
  }

  const baseAllPowerW = Number(adjusted.conso_all_eim_wNow);
  if (Number.isFinite(baseAllPowerW)) {
    adjusted.conso_all_eim_wNow = Math.round(baseAllPowerW + signedPowerW);
  }

  const baseNetWhLifetime = Number(adjusted.conso_net_eim_whLifetime);
  if (Number.isFinite(baseNetWhLifetime)) {
    adjusted.conso_net_eim_whLifetime = Math.max(0, Math.round(baseNetWhLifetime + energyOffsetWh));
  }

  const baseNetKwhLifetime = Number(adjusted.conso_net_eim_kwhLifetime);
  if (Number.isFinite(baseNetKwhLifetime)) {
    adjusted.conso_net_eim_kwhLifetime = Math.max(0, Number((baseNetKwhLifetime + energyOffsetWh / 1000).toFixed(3)));
  }

  const baseAllWhLifetime = Number(adjusted.conso_all_eim_whLifetime);
  if (Number.isFinite(baseAllWhLifetime)) {
    adjusted.conso_all_eim_whLifetime = Math.max(0, Math.round(baseAllWhLifetime + energyOffsetWh));
  }

  const baseAllKwhLifetime = Number(adjusted.conso_all_eim_kwhLifetime);
  if (Number.isFinite(baseAllKwhLifetime)) {
    adjusted.conso_all_eim_kwhLifetime = Math.max(0, Number((baseAllKwhLifetime + energyOffsetWh / 1000).toFixed(3)));
  }

  // to_grid (export) diminue quand la conso externe augmente, et inversement.
  const baseGridWhLifetime = Number(adjusted.grid_eim_whLifetime);
  if (Number.isFinite(baseGridWhLifetime)) {
    adjusted.grid_eim_whLifetime = Math.max(0, Math.round(baseGridWhLifetime - energyOffsetWh));
  }

  const baseGridKwhLifetime = Number(adjusted.grid_eim_kwhLifetime);
  if (Number.isFinite(baseGridKwhLifetime)) {
    adjusted.grid_eim_kwhLifetime = Math.max(0, Number((baseGridKwhLifetime - energyOffsetWh / 1000).toFixed(3)));
  }

  // import (tire du reseau) augmente quand la conso externe augmente: ce qu'elle
  // consomme sans venir du solaire a bien fallu le tirer du reseau.
  const baseImportWhLifetime = Number(adjusted.import_eim_whLifetime);
  if (Number.isFinite(baseImportWhLifetime)) {
    adjusted.import_eim_whLifetime = Math.max(0, Math.round(baseImportWhLifetime + energyOffsetWh));
  }

  const baseImportKwhLifetime = Number(adjusted.import_eim_kwhLifetime);
  if (Number.isFinite(baseImportKwhLifetime)) {
    adjusted.import_eim_kwhLifetime = Math.max(0, Number((baseImportKwhLifetime + energyOffsetWh / 1000).toFixed(3)));
  }

  // economie = production - to_grid
  const prodWhLifetime = Number(adjusted.prod_eim_whLifetime);
  const gridWhLifetime = Number(adjusted.grid_eim_whLifetime);
  if (Number.isFinite(prodWhLifetime) && Number.isFinite(gridWhLifetime)) {
    adjusted.eco_eim_whLifetime = Math.max(0, Math.round(prodWhLifetime - gridWhLifetime));
  }

  const prodKwhLifetime = Number(adjusted.prod_eim_kwhLifetime);
  const gridKwhLifetime = Number(adjusted.grid_eim_kwhLifetime);
  if (Number.isFinite(prodKwhLifetime) && Number.isFinite(gridKwhLifetime)) {
    adjusted.eco_eim_kwhLifetime = Math.max(0, Number((prodKwhLifetime - gridKwhLifetime).toFixed(3)));
  }

  return adjusted;
}
