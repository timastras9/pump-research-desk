# Data analysis

Reviewed datasets and model-review reports. Every file here is produced by a script in `scripts/` from the launch
corpus, so it can be regenerated.

## Exit labels

| File | Contents | Produced by |
|---|---|---|
| `exit_labels_v4.xlsx` | Current exit labels in the review layout. Column R = peak − target exit; highlighted when the target is below 0 or R is above 10 | `scripts/export_label_check.py` |
| `exit_labels_v4.csv` | Same labels as CSV | `scripts/export_label_review.py` |
| `exit_labels_v1_tim_review.numbers` | Owner's review of the first label set; source of the v3/v4 rules | manual review |
| `price_anomalies.csv` | Launches excluded for impossible price jumps (>20× in one second, or >30× launch price within 60 s) | `scripts/export_label_review.py` |

## Training data

| File | Contents | Produced by |
|---|---|---|
| `training_dataset_v2.csv` | One row per launch: early features known at decision time, plus outcome labels | `scripts/build_training_dataset.py` |
| `training_dataset_v2_dictionary.json` | Column definitions and which columns are safe to use as model inputs | `scripts/build_training_dataset.py` |
| `entry_kpis.csv` | Entry-time metrics for every launch, used for the loser analysis | `scripts/loser_patterns.py` |
| `entry_filter_test.json` | Wait-then-filter entry test results | `scripts/entry_filter_test.py` |

## Model reviews

| File | Contents |
|---|---|
| `ASTRA_SYSTEM_DESIGN.md` | Design for the buy model, RL sell model and feedback loop (approved) |
| `astra_system_design.json` | Raw response behind the design document |
| `astra_losers_v3.csv` | Losing launches sent for pattern review |
| `astra_gpt-oss_answer.json` | gpt-oss-120b loser-pattern analysis |
| `astra_gpt6_verification.json` | GPT-6 Astra verification of that analysis |
