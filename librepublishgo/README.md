# From librepublishgo

Copies of the files in [librepublishgo](https://github.com/Martin-Business-Consultants/librepublishgo)
that this integration's tests are held to. Don't edit them here; take them
from a checkout with `npm run contracts:sync -- ../librepublishgo`.

| Path | What |
| --- | --- |
| `contracts/` | The API contract: answers recorded from a real Go core (its `contracts/README.md` says how). |
| `plugins/forms/manifest.go` | The Forms plugin's field palette, which `FIELD_TYPES` must match. |
| `SOURCE` | The librepublishgo commit they're from; CI's end to end builds the Go core at it. |
