import yaml

from motes import config


def test_init_writes_a_short_starter_and_update_keeps_it_short(tmp_path, monkeypatch):
    monkeypatch.setenv("MOTES_HOME", str(tmp_path))
    path = config.init()
    assert path.read_text().startswith("# Motes settings")
    config.update({"brain": {"model": "qwen3:4b", "native_tools": True}})
    text = path.read_text()
    assert text.startswith("# Motes settings")  # header comments survive
    assert yaml.safe_load(text) == {"brain": {"model": "qwen3:4b", "native_tools": True}}  # no frozen defaults
    assert config.load()["autonomy"]["max_steps"] == config.defaults()["autonomy"]["max_steps"]
    config.update({"brain": {"temperature": 0.1}})
    assert yaml.safe_load(path.read_text())["brain"] == {"model": "qwen3:4b", "native_tools": True, "temperature": 0.1}


def test_old_decision_settings_are_carried_over(tmp_path, monkeypatch):
    monkeypatch.setenv("MOTES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(yaml.safe_dump({"decision": {
        "engine": "laya", "laya": {"url": "http://x:8000"}, "system2": {"enabled": True},
        "llm": {"model": "qwen3:4b", "base_url": "http://judge:11434/v1"}}}))
    dec = config.load()["decision"]
    assert dec["model"] == "qwen3:4b" and dec["base_url"] == "http://judge:11434/v1"
    assert not {"engine", "laya", "llm", "system2"} & set(dec)


def test_access_token_lives_in_a_private_file(tmp_path, monkeypatch):
    monkeypatch.setenv("MOTES_HOME", str(tmp_path))
    assert config.access_token() == ""
    token = config.access_token(create=True)
    assert len(token) > 20 and config.access_token() == token
    assert (tmp_path / "token").stat().st_mode & 0o077 == 0
    assert not (tmp_path / "config.yaml").exists()  # the config file is never touched
