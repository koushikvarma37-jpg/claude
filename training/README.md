# Teaching the decision model your taste

Motes uses your Ollama model twice: as the **brain**, which plans and calls tools,
and as the **decision model**, which judges each risky action in a separate, fresh
conversation. Out of the box the decision model is the same model as the brain.
This folder turns it into a specialist tuned to *your* standards.

## How it works

[RLCD](https://arxiv.org/abs/2307.12950) (Reinforcement Learning from Contrastive
Distillation) makes preference data without hand labelling:

1. Take a situation: goal + proposed action + risk.
2. Ask the model twice: once with a **positive** prompt (careful, protective, but
   helpful) and once with a **negative** prompt (careless or pointlessly obstructive).
3. The positive answer is *chosen*, the negative one *rejected*.
4. Train on those pairs with DPO. The trained model then behaves like the positive
   prompt with just the plain prompt.

Your own history goes on top: every time you press **Approve** or **Deny**, that answer
becomes a gold label that overrides the synthetic one. The more you use Motes, the
more the decision model learns your taste.

## Steps

```bash
# 1. Build pairs from the decisions Motes logged, plus the starter scenarios.
#    Uses your configured decision model (through Ollama) to generate the contrasts.
motes rlcd build --out data/rlcd.jsonl --seed training/seed_scenarios.jsonl

# 2. Train a LoRA with DPO (needs a GPU; ~16 GB VRAM for a 4B model).
pip install "motes[train]"
python training/train_dpo.py --data data/rlcd.jsonl --base Qwen/Qwen3-4B-Instruct-2507 --out out/decider --merge

# 3. Convert to GGUF and load it into Ollama.
git clone https://github.com/ggml-org/llama.cpp
python llama.cpp/convert_hf_to_gguf.py out/decider/merged --outfile decider.gguf --outtype q8_0
#    Use examples/ollama/Modelfile.qwen3 as the Modelfile (change its FROM line to
#    ./decider.gguf); it carries Qwen's chat template, which a bare FROM line lacks.
ollama create motes-decider -f Modelfile

# 4. Use it:  ~/.motes/config.yaml  ->  decision: { model: motes-decider }
motes doctor
```

Tips:

- Add your own situations to `seed_scenarios.jsonl`. `label` (approve / deny /
  ask_human) is optional: with it, the row is a gold example; without it, RLCD decides.
- `--keep-ties` keeps pairs where both prompts reached the same verdict (they still
  differ in confidence and reasoning). By default they are dropped.
- Keep some of your labelled situations out of training and check the new model on
  them before switching to it.
- Retrain every few weeks as your approvals pile up.
