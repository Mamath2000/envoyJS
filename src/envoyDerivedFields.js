/**
 * Calcule les champs derives (grid/eco/courant/lifetime) a partir des champs
 * bruts normalises d'Envoy, en appliquant une correction optionnelle (ex:
 * tableau electrique deporte). Fonction pure, un seul passage de calcul.
 */

// Paires whLifetime -> kwhLifetime: le kWh est toujours simplement le Wh / 1000,
// jamais recalcule independamment (ca evite de dupliquer chaque formule de
// correction une deuxieme fois pour rien).
const KWH_SENSOR_PAIRS = [
  ["prod_eim_whLifetime", "prod_eim_kwhLifetime"],
  ["conso_net_eim_whLifetime", "conso_net_eim_kwhLifetime"],
  ["conso_all_eim_whLifetime", "conso_all_eim_kwhLifetime"],
  ["grid_eim_whLifetime", "grid_eim_kwhLifetime"],
  ["import_eim_whLifetime", "import_eim_kwhLifetime"],
  ["eco_eim_whLifetime", "eco_eim_kwhLifetime"],
  ["edf_import_whLifetime", "edf_import_kwhLifetime"],
  ["eco_edf_whLifetime", "eco_edf_kwhLifetime"],
  ["togrid_edf_whLifetime", "togrid_edf_kwhLifetime"],
];

function addKwhSensors(adjusted) {
  for (const [whKey, kwhKey] of KWH_SENSOR_PAIRS) {
    const wh = Number(adjusted[whKey]);
    if (Number.isFinite(wh)) {
      adjusted[kwhKey] = Number((wh / 1000).toFixed(3));
    }
  }
  return adjusted;
}

export function deriveEnvoyFields(rawFields, correction = {}) {
  if (!rawFields || typeof rawFields !== "object") return rawFields;

  const signedPowerW = Number(correction.signedPowerW ?? 0);
  const energyOffsetWh = Number(correction.energyOffsetWh ?? 0);

  const adjusted = { ...rawFields };

  // Champ temps réél :
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

  // Index energie
  const baseNetWhLifetime = Number(adjusted.conso_net_eim_whLifetime);
  if (Number.isFinite(baseNetWhLifetime)) {
    adjusted.conso_net_eim_whLifetime = Math.max(0, Math.round(baseNetWhLifetime + energyOffsetWh));
  }

  const baseAllWhLifetime = Number(adjusted.conso_all_eim_whLifetime);
  if (Number.isFinite(baseAllWhLifetime)) {
    adjusted.conso_all_eim_whLifetime = Math.max(0, Math.round(baseAllWhLifetime + energyOffsetWh));
  }

  // to_grid (export) est un cumul d'energie reellement injectee au reseau: ca ne
  // peut physiquement jamais redescendre (si on importe, on n'exporte simplement
  // pas — l'export ne "recule" pas pour autant). La soustraction de energyOffsetWh
  // (qui ne fait qu'augmenter) peut faire chuter la valeur brute corrigee en
  // dessous de ce qui a deja ete atteint: on clampe donc au plus haut jamais vu
  // (previousGridEimWhLifetime, fourni par l'appelant qui persiste ce maximum
  // d'un cycle a l'autre), pour garantir la monotonie.
  const baseGridWhLifetime = Number(adjusted.grid_eim_whLifetime);
  if (Number.isFinite(baseGridWhLifetime)) {
    const correctedGridWhLifetime = Math.max(0, Math.round(baseGridWhLifetime - energyOffsetWh));
    const previousGridWhLifetime = Number(correction.previousGridEimWhLifetime);
    adjusted.grid_eim_whLifetime = Number.isFinite(previousGridWhLifetime)
      ? Math.max(previousGridWhLifetime, correctedGridWhLifetime)
      : correctedGridWhLifetime;
  }

  // import (tire du reseau) augmente quand la conso externe augmente: ce qu'elle
  // consomme sans venir du solaire a bien fallu le tirer du reseau.
  const baseImportWhLifetime = Number(adjusted.import_eim_whLifetime);
  if (Number.isFinite(baseImportWhLifetime)) {
    adjusted.import_eim_whLifetime = Math.max(0, Math.round(baseImportWhLifetime + energyOffsetWh));
  }

  // economie = production - to_grid
  const prodWhLifetime = Number(adjusted.prod_eim_whLifetime);
  const gridWhLifetime = Number(adjusted.grid_eim_whLifetime);
  if (Number.isFinite(prodWhLifetime) && Number.isFinite(gridWhLifetime)) {
    adjusted.eco_eim_whLifetime = Math.max(0, Math.round(prodWhLifetime - gridWhLifetime));
  }

  // Compteur EDF (Linky, index EAST): situe avant la scission maison/tableau
  // ext, il voit deja le vrai import combine des deux reseaux — aucune
  // correction a lui appliquer. On en deduit eco/to_grid par conservation
  // d'energie ("ce qui est consomme = ce qui est importe + ce qui est
  // autoconsomme"), une identite lineaire toujours vraie (contrairement a la
  // correction grid_eim/tableau ext ci-dessus, qui dependait de quel reseau
  // exportait/importait a quel instant — voir doc 6.3/6.4).
  //
  // Pas de clamp a 0 ici, volontairement: conso_all_eim_whLifetime et
  // edf_import_whLifetime ne partent pas du meme "zero" (le compteur Linky
  // compte depuis sa propre installation, generalement bien avant le suivi
  // logiciel de conso_all) — la difference absolue peut donc etre negative,
  // sans aucune signification physique en tant que "total depuis toujours".
  // Ce qui compte, et qui reste correct malgre ce decalage arbitraire, c'est
  // le delta entre deux instants (_today/_yesterday, via _00h): ce decalage
  // s'annule dans la soustraction, et le delta est physiquement toujours >= 0
  // (Δeco_edf(t) = Δconso_all(t) - Δedf_import(t) = autoconsommation reelle de
  // l'instant >= 0). Un clamp a 0 ici ecraserait ce delta a chaque cycle des
  // que le decalage d'origine est negatif, rendant _today/_yesterday
  // definitivement bloques a 0 (incident reel observe le 2026-07-23).
  const edfImportWhLifetime = Number(correction.edfImportWhLifetime);
  if (Number.isFinite(edfImportWhLifetime)) {
    adjusted.edf_import_whLifetime = Math.round(edfImportWhLifetime);

    const consoAllWhLifetime = Number(adjusted.conso_all_eim_whLifetime);
    if (Number.isFinite(consoAllWhLifetime)) {
      adjusted.eco_edf_whLifetime = Math.round(consoAllWhLifetime - edfImportWhLifetime);

      if (Number.isFinite(prodWhLifetime)) {
        adjusted.togrid_edf_whLifetime = Math.round(prodWhLifetime - adjusted.eco_edf_whLifetime);
      }
    }
  }

  return addKwhSensors(adjusted);
}
