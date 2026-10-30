# DataGateway

[![Liberapay](https://img.shields.io/liberapay/receives/WarWolfen.svg?logo=liberapay)](https://liberapay.com/WarWolfen)

Provides the API to access the database.

## Planet fight selection

`GET /c3attack/season/:seasonId/list` returns all attacks of the season, including
attacks with a recorded winner, ordered by round and ID descending. Existing
`id`, `season`, `name` and `round` fields remain. Additional fields:

- `winnerfaction_id`: positive winner faction ID, otherwise `null`.
- `has_winner`: visual status only; it does not prevent selecting an attack.
- `factions`: `{ faction_id, name: { de, en }, pcp }` entries. Names come from
  `c3_FACTION`; unavailable names are `null` so clients can fall back to the ID.

Faction membership is collected from the attack row's `FactionID` / `FactionID_*`
references (including the winner) and factions with score entries. Attack roles
are read from the row rather than hard-coding undocumented role column names.
Referenced factions without score entries have zero PCP. PCP are the sum of
**booked** `c3_SCORE.PCP` per season, attack and faction, not the live auxiliary
player highscore or an inferred winner. Unassigned attack-zero awards and scores
from other seasons are excluded. The list uses at most three database queries.

Invalid season IDs return 400, an empty season retains the existing 404 response.
No schema migration is required. Deploy DataGateway before the frontend to show
the additional details; older responses remain displayable without those details.

## Auxiliary fight team size

Before deploying, run `doc/fight-teamsize.sql` against the MariaDB database.
The script also handles an already existing `fight_teamsize` column, normalizes
legacy NULL/zero/negative values to 1, and ensures `INT NOT NULL DEFAULT 1`
with a positive-value check. No migration is executed automatically at startup.

`POST /auxfights` accepts optional `fight_teamsize` (integer 1–2147483647).
Omitting it defaults to 1 so existing clients continue to work. Explicit NULL,
zero, negative, fractional and string values are rejected with HTTP 400.
Fight responses include the team size; legacy missing/invalid values read as 1.
On the first successful confirmation, the awarded PCP are
`PCP_AUX × fight_teamsize`. Each confirmed fight inserts a new `c3_SCORE` row:
`FactionID` is the winning faction, `AttackID` is the selected `c3_attack_id`,
and `SeasonId` comes from that attack. `PATCH /auxfights/:id/winner` also accepts
explicit integer `c3_attack_id: 0` for no planet assignment. In that case,
confirmation awards the same PCP with `AttackID = 0` and fixed `SeasonId = 1`,
without looking up an attack. Missing, NULL, negative, fractional and string
attack IDs are rejected on submission. Existing score rows are never updated,
even when multiple rows already share this faction/attack/season combination.
`GET /score` continues to return the sum of all matching rows. Repeated
confirmations of the same fight do not award again; insertion and confirmation
are committed together under the fight's row lock. Rejecting a result awards no PCP.

The `c3_SCORE` schema must allow multiple rows per faction/attack/season;
a unique constraint on that combination would prevent these individual awards.
Previously aggregated rows are retained unchanged, not split retroactively.

Run isolated API regression tests without a database: `node --test test/*.test.js`.
The highscore tests require Node 22.13+ and use its built-in SQLite module to
execute the aggregation SELECT against isolated fixtures; production remains
MariaDB. No production database connection or credentials are used by the tests.

## Auxiliary highscore

`GET /auxfights?count=true&factions=true&pcp=true` adds `pcp` to each faction's
statistics for the smaller totals below the large win scoreboard. These are
all-season **booked** `c3_SCORE.PCP` totals per positive faction ID, including
`AttackID = 0` and factions with bookings but no auxiliary wins. Wins and PCP
are aggregated independently so neither multiple fights nor multiple awards
multiply totals. Player highscore points and current reference values are not
used for these totals. Calls without `pcp=true` retain their existing response.

Add `vp=true` to include `vp`, the corresponding all-season sum of booked
`c3_SCORE.VP` per faction. The frontend requests
`GET /auxfights?count=true&factions=true&pcp=true&vp=true` and shows these victory
points directly beneath each faction. `vp=true` also works independently of
`pcp=true`; unrequested fields are omitted. NULL bookings and missing bookings
sum to zero. Factions with score entries but no auxiliary wins remain included.
Wins, PCP and VP are aggregated without multiplying one another; player scores
and PCP reference recalculations are not used. Deploy the API before the frontend;
the existing `c3_SCORE.VP` column is used, so no schema migration is required.

Only the existing `doc/fight-teamsize.sql` migration is required. No additional
highscore columns or migration are needed. Deploy this API before the frontend.

`GET /auxusers/highscore` is public and returns all users, including users without
fights, as an array of `{ rank, id_user, username, fights, pcp }` across all seasons.
Only confirmed fights with a positive winner count as played for every
participant, including losses. Every participant whose faction wins receives the
**full** fight PCP, regardless of `aux_fightusers.fightcreator` or planet
assignment (including `c3_attack_id = 0`). Losing participants receive zero. Duplicate memberships
count once per user/fight. Totals descend by PCP; equal totals share a competition
rank (1, 1, 3), with names and user IDs breaking display ties.

PCP are calculated live on every request as current `PCP_AUX` multiplied by
`fight_teamsize`, for the entire history. Legacy NULL/zero/negative team sizes
count as 1. Reference changes therefore affect historical totals on the next
request. A missing, duplicated or invalid reference returns HTTP 500 rather than
misleading zero totals. No per-fight PCP snapshots are read or written.

The read-only ranking does not change `c3_SCORE` or issue additional faction
points. Existing transactional faction awards remain unchanged and repeated
confirmations still do not pay twice. If the superseded `doc/fight-highscore.sql`
was previously applied, its `pcp_awarded` column is unused and need not be filled
or migrated; the file no longer changes the schema.

# Copyright
This software is a completely free fan project that makes no claim to ownership to any of Catalyst Game Labs or The Topps Company, Inc properties. MechWarrior, BattleMech, ‘Mech and AeroTech are registered trademarks of The Topps Company, Inc. All Rights Reserved. Catalyst Game Labs and the Catalyst Game Labs logo are trademarks of InMediaRes Production, LLC. Neither Topps nor Catalyst Game Labs makes no representation or warranty as to the quality, viability, or suitability for purpose of this product.
See additional information on the [BattleTech - The Board Game](https://bg.battletech.com/?page_id=34) Website.

# Support
If you want to support C3 or ASCard, consider to donate via liberapay or paypal:
* [Liberapay](https://liberapay.com/WarWolfen "Liberapay")
* [Paypal](https://www.paypal.com/paypalme/ClanWolf?country.x=DE&locale.x=de_DE "Paypal")
