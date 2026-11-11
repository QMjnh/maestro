# Dev plan

## Song deduplication

**Status:** not solved. A regex prototype is parked on the `wip/regex-song-dedupe` branch and should not be merged.

**Problem.** The same song shows up several times in Home mixes, recommendation rows, and autoplay. It can be a
reupload, or the official artist posting on more than one service. For example, these are all one song:

- `BẠC PHẬN | ICM x JACK | OFFICIAL MV` by ICM Entertainment (YouTube)
- `BẠC PHẬN | K-ICM ft. JACK` by K-ICM (SoundCloud)
- `Bạc Phận` by chonlatot, an unrelated reuploader (SoundCloud)

**Why not regex.** The prototype parses titles with regex and word lists, then compares titles, credits, and length.
It handles the cases it was tuned on, but it can't be trusted beyond them:

- Every title format and language needs its own rule. Vietnamese "bản thu" had to be added by hand, and other
  languages would each need the same.
- Each round of checking real data found new wrong merges, fixed with another special case.
- It guesses from text. It doesn't actually know which recording an upload is.

**What's needed.** A way to establish song identity that doesn't depend on hand-written title parsing.

Ideas to evaluate (none tested yet):

- **Match to a catalog.** Resolve each upload to a canonical recording, using Spotify search, YouTube Music's catalog,
  or MusicBrainz/ISRC, and compare those IDs. Needs a check on how well it covers reuploads and Vietnamese music, and
  on rate limits.
- **Learned text similarity.** Compare title and artist with embeddings or a small language model instead of rules.
  Needs a decision on running locally or calling a service, and on cost and latency.
- **Audio fingerprinting.** The most direct evidence, but Maestro plays through embedded players and the Spotify app,
  so it may not have access to the audio.

**Requirements for a replacement**

- Merge reuploads and the same release across services, and keep the most official copy.
- Don't merge different songs that share a title or an artist.
- Never remove songs the user added, or anything in their own playlists.
- Loading Home must still never start Spotify.

**Open question.** Should remixes, live recordings, covers, and other versions count as separate songs or be filtered
out of recommendations? The prototype keeps them separate, and treats slowed, nightcore, and 8D edits as duplicates.

**Reusable from the prototype.** `tools/test-song-dedupe.js` on the branch has 29 labelled same/different pairs, mostly
taken from real recommendations. Keep the pairs as an acceptance test for the replacement. The script itself calls the
prototype's functions and will need adapting.

**Current behavior until this is done.** `home-page` has only the old key-based check, which misreads titles like
`Title | Artist`, so duplicates like the example above still appear.
