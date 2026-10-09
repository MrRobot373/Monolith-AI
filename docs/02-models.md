# Models and Auto

Aatmiq talks to models through providers (vLLM, Ollama, or any OpenAI-compatible server) that
admins add in **Admin → Models**. Each model has:

| Setting | What it does |
|---|---|
| Sections | Where it can be used: Chat, Work AI, Code |
| Images | It reads pictures (the agent can look at screenshots) |
| Thinking | It can switch thinking on and off per request (Qwen3, Nemotron 3, on vLLM or Ollama). Off for everyday answers; on for hard ones with Auto |
| Auto tier | Fast, Standard or Advanced: where Auto uses it (or *Not used*) |

Ollama models report images and thinking themselves when added. The team server registers its
models with their tiers at first setup ([10-team-server.md](10-team-server.md#the-models)).

## Auto

Auto picks the model for each message (each task in Work AI and Code) by how hard the request is:
quick questions go to a fast model, everyday work to the standard one, and hard problems to the
strongest, with thinking on. People see **Auto** first in every model menu; each answer shows what
Auto picked and why (hover the *Auto · fast* chip), and anyone can still pick a model by hand.

It's offered when someone's models cover at least two tiers. It's the default for new chats and
tasks unless the admin turns *Start with Auto* off.

### How it decides

1. **Rules** read the request (instant, no model involved):

   | Decision | When |
   |---|---|
   | Easy | Greetings and thanks; quick rewrites, translations, spelling and grammar fixes; definitions and short facts; short summaries; very short questions |
   | Medium | Questions about code; calculations; long texts; anything answered from documents or project sources; requests in another script (the small models are made for English) |
   | Hard | Code with an error or a request to debug, optimize or review it, or more than 40 lines; math beyond arithmetic (derivatives, proofs, probability); requests with several parts that ask for analysis, comparison, design, strategy, legal or financial review |
   | Unclear | The rest (an email to write, a report, a "why" question) |

2. **The judge** takes the unclear ones: the fast model reads the request and answers one word,
   *easy*, *medium* or *hard*, with thinking off and at most 8 tokens (well under a second on a
   GPU). If it doesn't answer clearly within 4 seconds, the request counts as medium. Admins can
   choose another judge model, or *Rules only* (unclear means medium).

3. **The tier**: easy → fast, medium → standard, hard → advanced. A tier without a model moves on
   (hard → standard, easy → standard), and so does a model that can't hold the conversation (its
   context length, counting the history and the sources).

4. **Thinking**: hard requests turn thinking on (on the advanced model, or the standard one when
   there's no advanced model); everything else answers directly. Models without the Thinking
   switch get no such instruction.

Two more rules keep it steady:

- A short follow-up ("and for Pune?", "in Python?") keeps the level of the answer before it, so the
  conversation doesn't drop to a weaker model halfway.
- Work AI and Code start at the standard tier: agents need reliable tool use, which small models
  don't have. A task keeps the model (and thinking) Auto chose when it started.

### Why not a separate classifier model?

A small classifier (Qwen3 0.6B, for example) was the other option. Most requests never need a model:
the rules decide them. For the rest, the fast model is already loaded, serves requests in parallel
and answers in a fraction of a second, so a separate model would add a server and memory for no gain.
To use a dedicated judge anyway, add it in Admin → Models (for example `qwen3:0.6b` on Ollama, tier
*Not used*) and pick it under **Auto → Unclear requests**.

### Settings

Admin → Models → **Auto**: the models in each tier, *Offer Auto*, *Start with Auto*, *Unclear
requests* (judge model or rules only), *Think on hard requests*, and a box to **try a message**:
it shows which model would answer and why, without sending the message to it.

The judge's tokens are counted under the judge model, like every other model call (Admin → Usage).

### API

Wherever a model id is accepted (`POST /api/chats`, `POST /api/chats/:id/messages`,
`POST /api/work/tasks`), `"auto"` means Auto. Answers carry `routing`:
`{ difficulty, tier, thinking, by: "rules" | "judge", reason }`; the stream sends `event: thinking`
when the model starts thinking. `GET /api/admin/routing`, `PUT /api/admin/routing` and
`POST /api/admin/routing/try` are for admins.

## Model licenses

| Model | License | Notes |
|---|---|---|
| Qwen3.6-35B-A3B | Apache-2.0 | |
| Gemma 4 E2B / E4B, EmbeddingGemma 2 | Apache-2.0 | |
| Nemotron 3 Nano 4B, Nano 30B A3B, Super 120B A12B | NVIDIA Nemotron Open Model License | Commercial use allowed; NVIDIA claims no rights to outputs. Whoever distributes the models passes on the license and its notice ("Licensed by NVIDIA Corporation under the NVIDIA Nemotron Open Model License"); NVIDIA's names and marks only to say where a model comes from |

The servers download the models from Hugging Face or the Ollama library at first start; Aatmiq's
own downloads don't bundle them. The offline bundle (see [11-rollout.md](11-rollout.md)) will,
and must carry these licenses.
