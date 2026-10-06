FROM python:3.12-slim

# Node and uv so the MCP app presets (npx / uvx) work inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml README.md ./
COPY motes ./motes
COPY training ./training
RUN pip install --no-cache-dir ".[notify]"

ENV MOTES_HOME=/data PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 7777
CMD ["motes", "up", "--no-browser", "--host", "0.0.0.0"]
