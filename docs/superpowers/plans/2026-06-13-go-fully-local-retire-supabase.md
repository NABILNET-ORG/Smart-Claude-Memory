# Plan — Going Fully Local and Retiring Supabase

**Status:** Proposal for your approval. Nothing here is executed yet. It runs **after** your data is safely rescued.
**Written in plain language on purpose** — no jargon. Anyone should be able to follow it.

---

## 1. What you asked for (so we're aligned)
You want to stop relying on the cloud database completely, and not just move it to your computer — you want to be free of Supabase **as a product** and run everything on a plain local database that you fully own. You asked for the genuinely correct, professional approach, not a shortcut. Confirmed.

## 2. The one thing to understand first (it changes everything)
The "local" database we already set up **is still Supabase** — it's the very same Supabase software, just running on your computer instead of their cloud. So there are really two different goals:

- **"Get off the cloud."** ✅ Already done — your local copy is on your machine, with no quotas or bills.
- **"Stop using Supabase entirely."** ⬅️ This is the bigger goal you're now asking for, and it means replacing the Supabase software with a plain database.

This matters because being "local" did **not** automatically make you "Supabase-free." This plan is about the second goal.

## 3. Does your system actually need Supabase? (Honest look)
I traced how your memory system uses it. It uses exactly three things:
- the database itself,
- the AI / "find similar meaning" search,
- a handful of saved database routines (search, knowledge-graph, clustering).

It does **not** use the things that make Supabase special: no user logins, no file storage, no live/real-time updates, no public web address for outside apps. In short, you're running a large, many-part system but only using its plain-database heart.

## 4. My professional recommendation
**Move to a plain PostgreSQL database with the vector ("AI search") add-on — and nothing else.**

Why this is the *correct* choice (not just the easy one):
- It is leaner and faster — one database instead of roughly a dozen background services you don't use.
- It is fully yours — no company, account, or product in the middle.
- It genuinely delivers "no Supabase," which is your actual goal.
- For a private, single-person memory system, it is the right long-term home.

**The honest trade-offs (you asked for truth, not comfort):**
- The original emergency — the cloud limits — is **already solved** just by being local. So this step is about ownership, leanness, and independence, not putting out a fire. It's a deliberate upgrade, not a rescue.
- It is **real work**, not a switch you flip. Today the app "speaks Supabase" in many places; we must teach it to speak directly to the plain database. The amateur move would be to tear it all out at once and hope. We will **not** do that — we do it in small, tested stages.
- **The one reason to NOT do this:** if you ever think you'll want user logins, a public web interface, or a hosted database again, keeping Supabase (even locally) would be worth it. Everything you've told me (private, local, single-user) says that doesn't apply — so the recommendation stands.

> If you'd prefer to keep the self-hosted Supabase instead (zero code changes, but still "Supabase"), say so and I'll adjust — but it would not meet your stated goal of leaving Supabase entirely.

## 5. The unbreakable rule: your data is sacred
- We never delete the cloud copy until the local copy is proven identical.
- We take a fresh backup **before every step** that changes data.
- Saving the data always comes first; changing the plumbing comes second.

## 6. The plan, step by step

**Phase 1 — Rescue the data (already planned; your 4-day step).**
Get your real data out of the restricted cloud and safely onto your machine first. This is the asset; nothing else starts until it's home. (Uses the rescue runbook we already wrote.)

**Phase 2 — Confirm what's actually in use.**
A quick, careful check that nothing quietly depends on Supabase's logins/storage/real-time before we plan to remove them. Removes any surprises.

**Phase 3 — Stand up the plain database.**
Set up a plain PostgreSQL database (with the vector add-on) on your machine, alongside everything else, and install the same structure your system already uses.

**Phase 4 — Build one clean "translator."**
Create a single place inside the app that talks directly to the plain database, hidden behind the same internal doorway the rest of the app already uses. This means the rest of the app won't need to know or care which database is underneath.

**Phase 5 — Switch the app over, one area at a time.**
Move each part across in turn — search, the knowledge graph, the backlog, the background workers, the dashboard — and **test each one before moving to the next.** Nothing proceeds on a part that isn't proven.

**Phase 6 — Move the data into the plain database.**
Copy your rescued data from the local Supabase into the plain database and confirm, table by table, that the counts and contents match exactly.

**Phase 7 — Run everything on the plain database and prove it.**
Full run-through: searches return real results, the dashboard fills in, the background workers behave. Verified before we remove anything.

**Phase 8 — Remove Supabase completely.**
Shut down and delete the local Supabase services, remove the Supabase connector and its settings from the app, and simplify the database permissions that only existed because of Supabase. After this, the word "Supabase" appears nowhere in your running system.

**Phase 9 — Retire the cloud account (last, and only when safe).**
Take one final full backup of the cloud and store it somewhere safe, then cancel/close the cloud project. Only after everything local is proven.

**Phase 10 — Update the documentation.**
Rewrite the project's notes so they describe the new, simpler, fully-local setup — so future-you isn't misled.

## 7. Sequencing (important)
This whole thing happens **after** your 4-day data rescue. First we get your data safely home (Phase 1). Then we calmly do the migration. Combining the urgent rescue with this big change in one rushed motion would be the risky, amateur path — so we keep them separate and ordered.

## 8. What I need from you
Just confirm the **direction**: the plain-database path (my recommendation), or keep self-hosted Supabase after all. Once you confirm — and once your data is rescued — I'll begin, stage by stage, with a checkpoint after each part.
