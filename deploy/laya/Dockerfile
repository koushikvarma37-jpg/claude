# Laya decision engine (https://github.com/NandhaKishorM/laya) served over HTTP for Motes.
# CPU build; for NVIDIA GPUs swap the torch index for a CUDA one and set LAYA_DEVICE=cuda.
FROM python:3.12-slim
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir "laya[serve]>=0.3.21"
ENV LAYA_HOST=0.0.0.0 LAYA_PORT=8000 LAYA_DEVICE=cpu
EXPOSE 8000
CMD ["laya-serve"]
