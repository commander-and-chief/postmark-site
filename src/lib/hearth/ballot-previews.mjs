// ballot-previews.mjs — the build's one map of Hearth designs to their live previews (POS-1066 A), for the boards that list the Hearth ballot.
//
// Build-time only (it reads the registered entries and the households this build carries); a page hands the map to its browser script as a
// data attribute, and the script reads it back through ballot-links.mjs § readPreviews. The rules are ballot-links.mjs's.

import { entries } from "./registry.mjs";
import { declaredHouses, houseOf } from "../household.mjs";
import { previewHrefs } from "./ballot-links.mjs";

export const hearthPreviews = previewHrefs(entries, { houses: declaredHouses(), houseOf });
