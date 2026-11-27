# iPhone checklist

Things only the real phone can confirm. Use the installed home-screen app, and first swipe it away in the app
switcher and reopen it so it runs the latest code. The app logs playback events to the server
(`data/client.log`), so for anything that fails, a rough time is enough.

Last run 2026-11-27: 1–5 passed. Picking a later chapter from the player's chapter list did nothing; fixed the same
day (added as 8). 6 and 7 not yet run.

| # | Steps | Expected |
|---|---|---|
| 1 | **Locked chapter change.** Open a book whose next chapter is rendered (✓ on the book page). Drag the scrubber to ~30 s before the end of a chapter, press play, lock the phone, wait a minute. | It carries on into the next chapter. The lock screen shows the new chapter's title. |
| 2 | **Cold start.** Swipe the app away, reopen it, tap the Continue card once. | Plays within a couple of seconds after that one tap (not "Tap play to start"). |
| 3 | **AirPods.** While playing: take one AirPod out, put it back, press to resume. Then try double- and triple-press. | Out pauses. Resume goes back a few seconds. Note what double and triple press did (next/previous sentence, or ±15 s). |
| 4 | **Interruption.** While playing with the phone locked, ask Siri something, or let a Maps navigation prompt speak. | Playback resumes by itself afterwards, a few seconds earlier. |
| 5 | **Lock screen.** While playing, open the lock screen controls: ±15 s, play/pause, the scrubber. | Each works. The scrubber is the current chapter. |
| 6 | **Offline.** On a book page choose *Next 3 h* and wait for "N chapters on this phone". Turn on Airplane mode, swipe the app away, reopen, play. Then drag into a chapter that isn't downloaded. | Plays from the phone. The other chapter says "You're offline and this part isn't downloaded", and the play button still answers. |
| 7 | **Waiting for rendering.** With the screen on, open a chapter that isn't rendered yet and press play. | The button spins at once, then "Rendering this part · about N s". It starts by itself. |
| 8 | **Later chapter from the player.** While playing, open the chapter list (☰) and pick a chapter that isn't rendered yet. Then do it again while paused. | Playing: it switches to that chapter and shows "Rendering this part · about N s", then plays by itself. Paused: it switches and says it isn't rendered yet. |
