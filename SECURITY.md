# Security Policy

## Supported versions
This is a single-file userscript, not a full application with releases and patches. “Supported” basically means: whatever is currently in `main`.

If you find a security issue in the latest `main`, we care.

## What is “security” here?
Examples of things we want to hear about:
- The script accidentally exposes sensitive Hulu session info in the HUD.
- The script leaks playback/session data to third-party URLs.
- The script can be used to keylog or hijack keyboard input outside the Hulu tab.
- The script can break Hulu behavior in a way that could be seen as hostile / ToS-violating beyond our stated scope.

Examples of things that are **not** considered security issues:
- “It lets me drag floating panels in front of Hulu’s UI.”
- “I can style it neon green.”
- “It won’t let me rewind into an ad break I already watched.”

## Reporting a vulnerability
Please open a **PRIVATE** report instead of a public GitHub issue if your discovery:
- Impacts user privacy,
- Could be abused to escalate privileges,
- Or could get users banned from Hulu.

How to disclose privately:
1. Open a new GitHub issue.
2. Put `[SECURITY]` at the start of the title.
3. In the body, say “requesting private contact.”
4. Do **not** include exploit details in the public text.

We’ll respond with a contact channel (email or DM) so you can share details.

## If you are Hulu or legal counsel for Hulu
You can also use this path to flag ToS conflicts. We will act in good faith to remove or modify features that worry you.
