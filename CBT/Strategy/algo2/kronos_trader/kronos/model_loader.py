"""Kronos model loader from HuggingFace — requires torch + transformers."""


class KronosModelLoader:
    def __init__(self, model_size: str = 'base', model_id: str = 'shiyu-coder/Kronos'):
        self.model_id = model_id
        self.model_size = model_size

    def load(self):
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer
            import torch
        except ImportError:
            raise ImportError("Install: pip install torch transformers huggingface_hub")

        device = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
        tag = f"{self.model_id}-{self.model_size}" if self.model_size != 'base' else self.model_id
        model = AutoModelForCausalLM.from_pretrained(tag, cache_dir='~/.cache/kronos', trust_remote_code=True)
        tokenizer = AutoTokenizer.from_pretrained(tag, cache_dir='~/.cache/kronos', trust_remote_code=True)
        model = model.to(device)
        model.eval()
        return model, tokenizer
