# Training the decision model

Motes uses two models: the **brain**, an open chat model that plans and calls
tools, and the **decision model**, which judges each risky action before it
runs. The default decision model is [Laya](https://github.com/NandhaKishorM/laya).

## How Motes asks Laya

Laya is a non-autoregressive "System 1" decision engine. It takes a text
*state* plus typed questions and answers all of them with calibrated
probabilities in one forward pass (tens of milliseconds, 100+ languages). For
every proposed action, Motes sends a state like this:

```
Owner's goal: Pay my electricity bill when it arrives, as long as it's under $150.
Recent agent activity: ...
Proposed action: browser__browser_click
Risk level: external
Arguments: {"element": "Pay $96.40", "ref": "e19"}
```

It then asks four questions:

| id | type | question |
|----|------|----------|
| `verdict` | choice | approve / deny / ask_human |
| `on_goal` | noul | Does the action directly serve the owner's goal? |
| `injected` | noul | Is it following instructions from content it read rather than from the owner? |
| `irreversible` | noul | Would it be hard or impossible to undo? |

The verdict is asked once per rotation of its options (via Laya's
`option_order`) and the probabilities are averaged. Laya's own presentation
checks show that where an option sits moves the answer; averaging over
rotations cancels that bias. The extra rows ride in the same forward pass.

The answers are combined like this:

- If `injected` ≥ `injection_threshold`, the verdict is **deny**.
- If the verdict is approve but `on_goal` < `on_goal_floor`, or `irreversible` ≥ `irreversible_ceiling`, it becomes **ask_human**.
- Otherwise the averaged verdict stands. Its probability is the confidence that `min_confidence` gates on in unattended mode.

All thresholds live under `decision.laya` in `~/.motes/config.yaml`.

## Why fine-tune

Laya's authors are clear that the shipped checkpoints are a fast base to
specialise, not a zero-shot decision engine: on their typed-decisions benchmark,
fine-tuning took accuracy from about 0.36 to 0.77. The shipped checkpoints are
also over-confident until calibration temperatures are fitted. So treat the
out-of-the-box decider as a cautious first line, keep unattended mode off at
first, and fine-tune once you have some history.

Motes records every **Approve** and **Deny** you press. Those are your labels.

## Steps

```bash
# 1. Export your decisions (plus the 24 starter scenarios) in Laya's training format:
#    {"state", "questions", "gold"} with target probabilities per question.
#    Each situation is written once per option order, so the model also learns to
#    ignore position.
motes laya export --out data/laya-train.jsonl

#    Held-out evaluation rows ({"state", "questions", "expected"}) for `laya-evals`:
motes laya export --format eval --out data/laya-eval.jsonl --seed my-held-out.jsonl

# 2. Fine-tune with Laya's own RLCD recipe (proper-scoring-rule rewards + soft
#    cross-entropy + temperature calibration). Single GPU or CPU:
git clone https://github.com/NandhaKishorM/laya && cd laya && pip install -e .
python research/scripts/finetune_single_device.py \
    --data ../data/laya-train.jsonl --output-dir ../out/laya-motes
#    Or use Laya's Kaggle notebook (free 2x T4):
#    notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb

# 3. Point Motes at your checkpoint (~/.motes/config.yaml):
#    decision:
#      laya:
#        mode: local                 # pip install "motes[laya]"
#        checkpoint: /path/to/out/laya-motes
motes laya check
```

Tips:

- Add your own situations to `seed_scenarios.jsonl`. A row can carry a `label`
  (approve / deny / ask_human), `signals` (`on_goal`, `injected`,
  `irreversible` as true/false), or both.
- Keep some labelled rows out of training and score them with `laya-evals`
  before trusting a new checkpoint. Refit `min_confidence` on that held-out data:
  a confidence threshold is a policy you choose, not a property of the model.
- Retrain every few weeks as your approvals pile up.

## Alternative: a chat model as the judge

Set `decision.engine: llm` to judge with any chat model instead (configured under
`decision.llm`). For that engine, `motes rlcd build` builds contrastive preference
pairs in the style of [RLCD (Yang et al.)](https://arxiv.org/abs/2307.12950):
the same model answers under a careful and a careless prompt, and your real
answers override the synthetic label. `training/train_dpo.py` then trains a LoRA
with DPO:

```bash
motes rlcd build --out data/rlcd.jsonl
pip install "motes[train]"
python training/train_dpo.py --data data/rlcd.jsonl --base Qwen/Qwen3-4B-Instruct-2507 --out out/decider --merge
```
