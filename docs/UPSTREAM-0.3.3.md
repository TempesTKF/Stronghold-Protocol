# v0.3.3 integration (2026-10-25)

Base: upstream tag v0.3.3 (`f07b8965`), including v0.3.2. The fork retains the server directory,
public-room switch, five-minute disconnected-room retention, announcements/admin console,
HTTP ZIP imports and installed cosmetic skins. Bulk asset predownload stays disabled.
The directory is reachable from the new upstream lobby; matchmaking uses the selected official version
and cannot join another version merely because the difficulty matches.

## AI and engine boundaries

The production entry and local admin launcher default `SP_BOT_STRATEGY` to `owner`.
An explicit environment setting wins. `botOwner.js` and `botIoletaOwner.js` retain this fork's
Russell/Touch procurement and placement; the original upstream strategies remain separate.
The owner policy uses the updated battle engine and shared rehearsal runner, including delegated
rehearsal limits. Direct engine construction retains upstream defaults for reproducible golden tests.
No upstream gameplay data or golden scenarios were modified.

The room-state guard was regenerated solely to retain `isPublic: true`. The Spring/Bubble regression
now checks v0.3.3's source-less ADDITION retaliation credited to Spring, instead of expecting Spring
as the damage source. No damage rule was changed in this integration.

## CI comparison

The upstream workflow is retained, including all four shards and the full golden job.
The shard weights drop only the two predownload tests whose feature this fork had already removed.
Owner-console strings now use the translation API and every shipped language pack.

Upstream v0.3.3 CI run 40134301219 failed in shard 1 on both Windows and Linux:
`test/version-assets.test.js` failed to import Pillow (`ModuleNotFoundError: No module named PIL`).
The other shards, CI guards, golden and tooling jobs succeeded. See
https://github.com/sganggs/Stronghold-Protocol/actions/runs/40134301219 .

Local Windows checks also reproduce upstream EPERM failures for symbolic-link fixtures and
Python launcher differences. These are reported separately, without disabling the tests or weakening
checks. The initial complete local run was followed by focused reruns after conflict and asset fixes.
