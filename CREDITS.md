# Credits

## Demo track

`public/audio/track.mp3` was generated with **YuE2** — the open music model from Multimodal Art
Projection (M·A·P) and HKUST — in 2026. It is the track the `element`, `decode` and `file` entry
points play (the `stream` entry uses the synthesized loop in `server/synth.ts`).

## YuE2 licence

YuE2 splits its licensing:

- **Inference code, agent skill and docs:** Apache 2.0.
- **Model weights (`YuE2-3B`, `YuE2-Vae`):** CC BY-NC 4.0, plus an **additional individual creator
  permission dated 2026-09-16**.

That creator permission is what matters for this audio. It lets personal users, content creators and
musicians acting in an individual capacity generate outputs and *"publish, distribute, sell, license
or otherwise monetize those outputs"*, with no fees or royalties payable to the model licensors,
subject to responsible-use conditions (no illegal, harmful, deceptive or unethical use). Companies
that want to use the weights commercially need a separate licence, and the weights themselves stay
CC BY-NC 4.0 — they may not be redistributed or sold commercially.

In practice, for a generated track:

- **Publishing and redistributing it is allowed**, including on commercial platforms, under the
  creator permission. This project uses it for a free, public demo.
- **Credit is optional but encouraged.** This project credits YuE2 here.
- The permission **only covers rights the model licensors hold**. It grants nothing in third-party
  material used as input (someone else's lyrics, melody or recording).
- **The track is excluded from this repository's MIT licence** — it is not ours to relicense.
- Copyright in AI-generated material varies by jurisdiction and may not subsist at all (the US
  Copyright Office requires human authorship). Treat this as a permission to use the audio, not as
  an exclusive asset to enforce.

## Sources (checked 2026-11-17)

- Project + licence summary: <https://github.com/multimodal-art-projection/YuE>
- Full weight licence and creator permission: <https://github.com/multimodal-art-projection/YuE/blob/main/MODEL_LICENSE>
- Model card (CC BY-NC 4.0): <https://huggingface.co/m-a-p/YuE2-3B>
- Paper: <https://arxiv.org/abs/2609.33757>

## If the track came from a hosted studio

The permission above comes from the model licensors. If the track was generated through a hosted
service rather than local weights, that service's terms also apply. For example, yue2music.com's
Terms of Service (2026-10-05) state that it claims no ownership over generated audio and that users
may monetise, distribute and release it, subject to its acceptable-use rules. Check which service was
actually used.

## Not legal advice

This note records the published terms on the dates above. Licences change — keep a copy if the
provenance matters.
