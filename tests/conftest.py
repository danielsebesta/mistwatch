import os

os.environ["MISTWATCH_NO_KEYRING"] = "1"  # tests must never touch the real OS keyring
