"""Fine-tune a decision model on RLCD pairs with DPO + LoRA.

    pip install "motes[train]"
    motes rlcd build --out data/rlcd.jsonl
    python training/train_dpo.py --data data/rlcd.jsonl --base Qwen/Qwen3-4B-Instruct-2507 --out out/decider

Then serve it (see training/README.md for GGUF + Ollama) and point
`decision.model` in ~/.motes/config.yaml at it.
"""

import argparse
import json

from datasets import Dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import DPOConfig, DPOTrainer


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="JSONL from `motes rlcd build`")
    ap.add_argument("--base", default="Qwen/Qwen3-4B-Instruct-2507", help="Hugging Face base model")
    ap.add_argument("--out", default="out/decider")
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--beta", type=float, default=0.1)
    ap.add_argument("--lr", type=float, default=5e-6)
    ap.add_argument("--merge", action="store_true", help="also save merged full weights to <out>/merged")
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(args.data) if l.strip()]
    for r in rows:
        r.pop("meta", None)
    data = Dataset.from_list(rows).train_test_split(test_size=0.1, seed=0) if len(rows) >= 20 else None

    tok = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype="auto", device_map="auto")

    cfg = DPOConfig(
        output_dir=args.out,
        beta=args.beta,
        learning_rate=args.lr,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=8,
        logging_steps=10,
        save_strategy="epoch",
        eval_strategy="epoch" if data else "no",
        bf16=True,
        report_to="none",
    )
    trainer = DPOTrainer(
        model=model,
        args=cfg,
        train_dataset=data["train"] if data else Dataset.from_list(rows),
        eval_dataset=data["test"] if data else None,
        processing_class=tok,
        peft_config=LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, target_modules="all-linear",
                               task_type="CAUSAL_LM"),
    )
    trainer.train()
    trainer.save_model(args.out)
    tok.save_pretrained(args.out)

    if args.merge:
        merged = trainer.model.merge_and_unload()
        merged.save_pretrained(f"{args.out}/merged")
        tok.save_pretrained(f"{args.out}/merged")
        print(f"merged weights in {args.out}/merged")


if __name__ == "__main__":
    main()
