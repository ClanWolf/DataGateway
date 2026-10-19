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
`PCP_AUX × fight_teamsize`. Only this new award is added to an existing score;
the previous total is not multiplied. Repeated confirmations do not award again.

Run isolated API regression tests without a database: `node --test test/*.test.js`.

# Copyright
This software is a completely free fan project that makes no claim to ownership to any of Catalyst Game Labs or The Topps Company, Inc properties. MechWarrior, BattleMech, ‘Mech and AeroTech are registered trademarks of The Topps Company, Inc. All Rights Reserved. Catalyst Game Labs and the Catalyst Game Labs logo are trademarks of InMediaRes Production, LLC. Neither Topps nor Catalyst Game Labs makes no representation or warranty as to the quality, viability, or suitability for purpose of this product.
See additional information on the [BattleTech - The Board Game](https://bg.battletech.com/?page_id=34) Website.

# Support
If you want to support C3 or ASCard, consider to donate via liberapay or paypal:
* [Liberapay](https://liberapay.com/WarWolfen "Liberapay")
* [Paypal](https://www.paypal.com/paypalme/ClanWolf?country.x=DE&locale.x=de_DE "Paypal")
