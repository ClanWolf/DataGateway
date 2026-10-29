# DataGateway

[![Liberapay](https://img.shields.io/liberapay/receives/WarWolfen.svg?logo=liberapay)](https://liberapay.com/WarWolfen)

Provides the API to access the database.

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
