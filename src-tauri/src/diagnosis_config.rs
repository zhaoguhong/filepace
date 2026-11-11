//! Connection-only configuration for metadata diagnosis. Never evaluate user
//! expressions or load project rules, executable plugins, or shell profiles.
use super::Agent;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Info {
    pub source: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub profile: Option<String>,
    pub profiles: Vec<String>,
    pub note: String,
}

#[derive(Default)]
pub(super) struct Connection {
    pub info: Info,
    pub values: Value,
    root: PathBuf,
}

fn read(path: &Path) -> Result<Option<String>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取 AI 配置，请检查文件权限".into()),
    };
    let mut text = String::new();
    file.take(2 * 1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| "AI 配置不是有效 UTF-8 文本")?;
    if text.len() > 2 * 1024 * 1024 {
        return Err("AI 配置超过 2 MiB，无法载入".into());
    }
    Ok(Some(text))
}

pub(super) fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|_| "无法创建临时 AI 配置".into())
}

fn pick(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| value.get(*key).map(|v| ((*key).into(), v.clone())))
            .collect(),
    )
}
fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn merge(target: &mut Value, next: Value) {
    if let (Some(a), Some(b)) = (target.as_object_mut(), next.as_object()) {
        for (k, v) in b {
            if v.is_object() && a.get(k).is_some_and(Value::is_object) {
                merge(a.get_mut(k).unwrap(), v.clone());
            } else {
                a.insert(k.clone(), v.clone());
            }
        }
    }
}
fn profile_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.len() > 100
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        Err("配置方案名称只能包含英文字母、数字、短横线或下划线".into())
    } else {
        Ok(name)
    }
}
fn json_config(path: &Path) -> Result<Value, String> {
    read(path)?
        .map(|text| {
            json5::from_str(&text).map_err(|_| "AI 配置格式有误，请在原工具中修复后重新检测".into())
        })
        .unwrap_or_else(|| Ok(json!({})))
}
fn toml_config(path: &Path) -> Result<Value, String> {
    read(path)?
        .map(|text| {
            toml::from_str::<toml::Value>(&text)
                .ok()
                .and_then(|v| serde_json::to_value(v).ok())
                .ok_or_else(|| "Codex 配置格式有误，请修复后重新检测".into())
        })
        .unwrap_or_else(|| Ok(json!({})))
}
fn env_root(name: &str, fallback: PathBuf) -> PathBuf {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or(fallback)
}

pub(super) fn load(agent: Agent, profile: Option<&str>) -> Result<Connection, String> {
    let home = dirs::home_dir().ok_or("无法确定个人目录")?;
    let root = match agent {
        Agent::Codex => env_root("CODEX_HOME", home.join(".codex")),
        Agent::Claude => env_root("CLAUDE_CONFIG_DIR", home.join(".claude")),
        Agent::Opencode => env_root(
            "OPENCODE_CONFIG_DIR",
            env_root("XDG_CONFIG_HOME", home.join(".config")).join("opencode"),
        ),
        Agent::Deepseek => env_root("DSH_HOME", home.join(".dsh")),
    };
    let mut result = load_from(agent, &root, profile)?;
    if agent == Agent::Opencode {
        if let Some(path) = std::env::var_os("OPENCODE_CONFIG").filter(|v| !v.is_empty()) {
            let path = PathBuf::from(path);
            if !path.is_file() {
                return Err("OPENCODE_CONFIG 指定的配置文件不存在".into());
            }
            let mut extra = json_config(&path)?;
            absolute_file_refs(&mut extra, path.parent().unwrap_or(&root));
            merge(&mut result.values, select_opencode(&extra)?);
            result.info.source = path.to_string_lossy().into_owned();
        }
        if let Ok(text) = std::env::var("OPENCODE_CONFIG_CONTENT") {
            let extra: Value = json5::from_str(&text).map_err(|_| "OpenCode 环境配置格式有误")?;
            merge(&mut result.values, select_opencode(&extra)?);
            result.info.source.push_str(" + OPENCODE_CONFIG_CONTENT");
        }
        result.set_opencode_info();
    }
    if agent == Agent::Claude {
        if let Ok(model) = std::env::var("ANTHROPIC_MODEL") {
            result.info.model = Some(model);
        }
    }
    Ok(result)
}

pub(super) fn load_from(
    agent: Agent,
    root: &Path,
    requested: Option<&str>,
) -> Result<Connection, String> {
    let mut result = Connection {
        root: root.to_owned(),
        values: json!({}),
        ..Connection::default()
    };
    result.info.note =
        "沿用已保存的连接配置；登录与连通性将在开始诊断时验证。终端临时参数和别名不会自动继承。"
            .into();
    match agent {
        Agent::Codex => {
            let path = root.join("config.toml");
            let mut config = toml_config(&path)?;
            result.info.source = path.to_string_lossy().into_owned();
            if let Some(profiles) = config["profiles"].as_object() {
                result.info.profiles.extend(profiles.keys().cloned());
            }
            if let Ok(entries) = fs::read_dir(root) {
                for entry in entries.flatten() {
                    if let Some(name) = entry
                        .file_name()
                        .to_str()
                        .and_then(|s| s.strip_suffix(".config.toml"))
                    {
                        if profile_name(name).is_ok() {
                            result.info.profiles.push(name.into());
                        }
                    }
                }
            }
            let profile = requested
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .or_else(|| string(&config, "profile"));
            if let Some(profile) = &profile {
                profile_name(profile)?;
                let file = root.join(format!("{profile}.config.toml"));
                let layer = if file.is_file() {
                    toml_config(&file)?
                } else {
                    config["profiles"]
                        .get(profile)
                        .cloned()
                        .ok_or("未找到所选 Codex 配置方案")?
                };
                merge(&mut config, layer);
            }
            result.info.profile = profile;
            result.info.model = string(&config, "model");
            result.info.provider = string(&config, "model_provider");
            result.values = pick(
                &config,
                &[
                    "model",
                    "model_provider",
                    "model_reasoning_effort",
                    "model_reasoning_summary",
                    "model_verbosity",
                    "model_context_window",
                    "model_max_output_tokens",
                    "openai_base_url",
                    "cli_auth_credentials_store",
                ],
            );
            if let Some(providers) = config["model_providers"].as_object() {
                let mut selected = Map::new();
                for (id, provider) in providers {
                    if Some(id) != result.info.provider.as_ref() {
                        continue;
                    }
                    if provider.get("api_key_helper").is_some() {
                        return Err(
                            "该 Codex 服务商依赖认证脚本，暂不支持受限诊断；请使用环境变量认证"
                                .into(),
                        );
                    }
                    selected.insert(
                        id.clone(),
                        pick(
                            provider,
                            &[
                                "name",
                                "base_url",
                                "env_key",
                                "env_key_instructions",
                                "wire_api",
                                "query_params",
                                "http_headers",
                                "env_http_headers",
                                "requires_openai_auth",
                                "supports_websockets",
                                "request_max_retries",
                                "stream_max_retries",
                                "stream_idle_timeout_ms",
                                "experimental_bearer_token",
                            ],
                        ),
                    );
                }
                result.values["model_providers"] = Value::Object(selected);
            }
        }
        Agent::Claude => {
            let path = root.join("settings.json");
            let config = json_config(&path)?;
            result.info.source = path.to_string_lossy().into_owned();
            result.info.model =
                string(&config, "model").or_else(|| string(&config["env"], "ANTHROPIC_MODEL"));
            result.info.provider = if config["env"].get("ANTHROPIC_BASE_URL").is_some() {
                Some("自定义服务地址".into())
            } else {
                None
            };
            // Claude safe-mode retains its native auth and model resolution.
        }
        Agent::Opencode => {
            for name in ["opencode.json", "opencode.jsonc"] {
                let path = root.join(name);
                if path.is_file() {
                    let mut config = json_config(&path)?;
                    absolute_file_refs(&mut config, root);
                    merge(&mut result.values, select_opencode(&config)?);
                    result.info.source = path.to_string_lossy().into_owned();
                }
            }
            if result.info.source.is_empty() {
                result.info.source = root.to_string_lossy().into_owned();
            }
            result.set_opencode_info();
            result
                .info
                .note
                .push_str(" 依赖第三方认证插件的服务商暂不支持。");
        }
        Agent::Deepseek => {
            let profiles = root.join("profiles");
            if let Ok(entries) = fs::read_dir(&profiles) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if entry.path().is_dir() && profile_name(&name).is_ok() {
                        result.info.profiles.push(name);
                    }
                }
            }
            let profile = requested.filter(|s| !s.is_empty()).unwrap_or("headless");
            profile_name(profile)?;
            if requested.is_some_and(|s| !s.is_empty()) && !profiles.join(profile).is_dir() {
                return Err("未找到所选 DeepSeek Harness 配置方案".into());
            }
            result.info.profile = Some(profile.into());
            result.info.source = format!(
                "{} + cordis.patch.yml",
                profiles.join(profile).to_string_lossy()
            );
            // Legacy settings have lower precedence than the selected profile.
            if let Some(text) = read(&root.join("settings.yaml"))? {
                let yaml: serde_yaml_ng::Value =
                    parse_yaml(&text).map_err(|_| "Harness settings.yaml 格式有误")?;
                for id in DSH_CONNECTION_ROWS {
                    if let Some(value) = yaml.get(*id) {
                        result.values[*id] = inert_yaml(value)?;
                    }
                }
            }
            for path in [
                profiles.join(profile).join("cordis.patch.yml"),
                root.join("cordis.patch.yml"),
            ] {
                if let Some(text) = read(&path)? {
                    let rows: serde_yaml_ng::Value =
                        parse_yaml(&text).map_err(|_| "Harness 配置格式有误")?;
                    let rows = rows.as_sequence().ok_or("Harness 配置必须为补丁列表")?;
                    for row in rows {
                        let Some(id) = row.get("id").and_then(serde_yaml_ng::Value::as_str) else {
                            continue;
                        };
                        if !DSH_CONNECTION_ROWS.contains(&id) {
                            continue;
                        }
                        if row.get("name").is_some()
                            || row
                                .get("disabled")
                                .is_some_and(|v| v.as_bool() != Some(false))
                        {
                            return Err(
                                "Harness 连接配置更换或禁用了内置适配器，暂不支持此方案".into()
                            );
                        }
                        if let Some(value) = row.get("config") {
                            result.values[id] = inert_yaml(value)?;
                        }
                    }
                }
            }
            result.info.model = string(&result.values["agent-default-model"], "model");
            result.info.provider = string(&result.values["agent-default-model"], "provider");
            result.info.note = "复用所选方案与全局配置中的内置模型连接、已保存凭据和 .env；不加载用户插件或配置表达式。默认读取 headless，可切换到 web 或 desktop。".into();
        }
    }
    result.info.profiles.sort();
    result.info.profiles.dedup();
    Ok(result)
}

const DSH_CONNECTION_ROWS: &[&str] = &[
    "agent-default-model",
    "llm-deepseek",
    "llm-pi-ai",
    "llm-deepseek-account",
];
// serde_yaml normalizes unknown !! global tags into ordinary values. Convert
// the Harness expression tag to a local tag so it remains inert and rejectable.
fn parse_yaml(text: &str) -> Result<serde_yaml_ng::Value, serde_yaml_ng::Error> {
    serde_yaml_ng::from_str(
        &text
            .replace("!!js", "!filepace_expression")
            .replace("!<tag:yaml.org,2002:js>", "!filepace_expression"),
    )
}
fn inert_yaml(value: &serde_yaml_ng::Value) -> Result<Value, String> {
    use serde_yaml_ng::Value as Y;
    match value {
        Y::String(s) => Ok(json!(s.replace("!filepace_expression", "!!js"))),
        Y::Tagged(_) => {
            Err("Harness 连接配置包含动态表达式，暂不支持；请选择使用静态连接配置的方案".into())
        }
        Y::Sequence(items) => items
            .iter()
            .map(inert_yaml)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Y::Mapping(items) => items
            .iter()
            .map(|(key, value)| {
                Ok((
                    key.as_str().ok_or("Harness 配置键必须是文本")?.into(),
                    inert_yaml(value)?,
                ))
            })
            .collect::<Result<Map<_, _>, String>>()
            .map(Value::Object),
        _ => serde_json::to_value(value).map_err(|_| "Harness 连接配置无法解析".into()),
    }
}
fn select_opencode(config: &Value) -> Result<Value, String> {
    for section in ["provider", "providers"] {
        if let Some(providers) = config[section].as_object() {
            for provider in providers.values() {
                if let Some(package) = provider
                    .get("npm")
                    .or_else(|| provider.get("package"))
                    .and_then(Value::as_str)
                {
                    if ![
                        "@ai-sdk/openai-compatible",
                        "@ai-sdk/openai",
                        "@ai-sdk/anthropic",
                        "@ai-sdk/google",
                        "@opencode/ai/providers/openai-compatible",
                        "@opencode/ai/providers/openai",
                        "@opencode/ai/providers/anthropic",
                        "@opencode/ai/providers/google",
                    ]
                    .contains(&package)
                    {
                        return Err("OpenCode 使用额外的 provider 包，暂不支持受限诊断；请使用内置兼容适配器".into());
                    }
                }
            }
        }
    }
    Ok(pick(
        config,
        &[
            "model",
            "small_model",
            "provider",
            "providers",
            "enabled_providers",
            "disabled_providers",
        ],
    ))
}
fn absolute_file_refs(value: &mut Value, root: &Path) {
    match value {
        Value::String(s) => {
            if let Some(file) = s.strip_prefix("{file:").and_then(|s| s.strip_suffix('}')) {
                if !Path::new(file).is_absolute() && !file.starts_with('~') {
                    *s = format!("{{file:{}}}", root.join(file).display());
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| absolute_file_refs(v, root)),
        Value::Object(items) => items.values_mut().for_each(|v| absolute_file_refs(v, root)),
        _ => {}
    }
}
fn toml_literal(value: &Value) -> String {
    match value {
        Value::Object(items) => format!(
            "{{{}}}",
            items
                .iter()
                .map(|(k, v)| format!("{} = {}", json!(k), toml_literal(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(toml_literal)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        _ => value.to_string(),
    }
}
impl Connection {
    fn set_opencode_info(&mut self) {
        self.info.model = string(&self.values, "model");
        self.info.provider = self
            .info
            .model
            .as_ref()
            .and_then(|s| s.split_once('/').map(|(p, _)| p.into()));
    }
    pub fn codex_args(&self, command: &mut Command) -> Result<(), String> {
        let mut values = self.values.clone();
        if let Some(providers) = values
            .get_mut("model_providers")
            .and_then(Value::as_object_mut)
        {
            for provider in providers.values_mut() {
                // Keep literal credentials out of argv. Auth state remains owned by
                // the original CODEX_HOME, including keyring-backed sign-ins.
                let mut headers = provider
                    .get("env_http_headers")
                    .cloned()
                    .unwrap_or(json!({}));
                if let Some(entries) = provider.get("http_headers").and_then(Value::as_object) {
                    for (index, (key, value)) in entries.iter().enumerate() {
                        let value = value.as_str().ok_or("Codex 请求头必须是文本")?;
                        let name = format!("FILEPACE_AI_HEADER_{index}");
                        command.env(&name, value);
                        headers[key] = json!(name);
                    }
                }
                if let Some(token) = provider
                    .get("experimental_bearer_token")
                    .and_then(Value::as_str)
                {
                    command.env("FILEPACE_AI_BEARER", format!("Bearer {token}"));
                    headers["Authorization"] = json!("FILEPACE_AI_BEARER");
                }
                if let Some(map) = provider.as_object_mut() {
                    map.remove("http_headers");
                    map.remove("experimental_bearer_token");
                }
                provider["env_http_headers"] = headers;
            }
        }
        if let Some(values) = values.as_object() {
            for (key, value) in values {
                command.args(["-c", &format!("{key}={}", toml_literal(value))]);
            }
        }
        Ok(())
    }

    pub fn harness(&self, work: &Path, command: &mut Command) -> Result<(), String> {
        let home = work.join("harness");
        let profile = home.join("profiles/filepace");
        fs::create_dir_all(&profile).map_err(|_| "无法创建 Harness 临时配置")?;
        private_write(
            &profile.join("package.json"),
            br#"{"name":"filepace-diagnosis","private":true,"dsh":{"profile":{"bundles":[]}}}"#,
        )?;
        // An explicit composition contains only official model/session services.
        // No file, shell, web, MCP, instruction, or plugin-loading services mount.
        let mut rows = Vec::new();
        for (id, package) in [
            ("timer", "cordis-plugin-timer"),
            ("llm", "dsh-llm"),
            ("session", "dsh-session"),
            ("session-projection", "dsh-session-projection"),
            ("agent", "dsh-agent"),
            ("tools", "dsh-tools"),
            ("tool-executor-native", "dsh-tool-executor-native"),
            ("system-prompt", "dsh-system-prompt"),
            ("agent-loop", "dsh-agent-loop"),
            ("session-persistence-jsonl", "dsh-session-persistence-jsonl"),
            ("llm-retry", "dsh-llm-retry"),
            ("credentials", "dsh-credentials-local"),
            ("authorization", "dsh-authorization"),
            ("deepseek-account", "dsh-deepseek-account"),
            ("llm-deepseek", "dsh-llm-deepseek-api-key"),
            ("llm-pi-ai", "dsh-llm-pi-ai"),
            ("llm-deepseek-account", "dsh-llm-deepseek-account"),
            ("agent-default-model", "dsh-agent-default-model"),
            ("headless-startup", "dsh-headless/startup"),
        ] {
            rows.push(json!({"id":id,"name":format!("@deepseek-ai/{package}")}));
        }
        for row in &mut rows {
            let id = row["id"].as_str().unwrap().to_owned();
            if let Some(config) = self.values.get(&id) {
                row["config"] = config.clone();
            }
            if id == "agent-default-model" && row.get("config").is_none() {
                row["config"] = json!({"provider":"deepseek-official","model":"deepseek-flash"});
            }
            if id == "system-prompt" {
                row["config"] = json!({"includeHarnessIdentity":false,"includeRuntimeContext":false,"personaPrefix":super::PROMPT});
            }
            if id == "session-persistence-jsonl" {
                row["config"] = json!({"root":home.join("sessions")});
            }
            if id == "credentials" {
                row["config"] = json!({"path":self.root.join(".credentials.yaml"), "watch":false});
            }
        }
        // Only these two expressions are authored by Filepace, never copied from a user patch.
        let mut patch = serde_yaml_ng::to_string(&json!([{"insert":rows}]))
            .map_err(|_| "无法生成 Harness 配置")?;
        patch.push_str("\n- insert:\n    - id: headless-runner\n      name: '@deepseek-ai/dsh-headless'\n      inject: [headlessStartup]\n      config:\n        task: !!js ctx.headlessStartup.task\n        json: !!js ctx.headlessStartup.json\n");
        private_write(&profile.join("cordis.patch.yml"), patch.as_bytes())?;
        for name in [".env"] {
            if let Some(text) = read(&self.root.join(name))? {
                private_write(&home.join(name), text.as_bytes())?;
            }
        }
        command
            .env("DSH_HOME", home)
            .args(["--profile", "filepace", "--json", "-"]);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_reuses_profile_connection_without_hooks_and_keeps_secrets_out_of_argv() {
        let root = tempfile::tempdir().unwrap();
        let original = r#"
model = "base-model"
model_provider = "company"
profile = "work"
notify = ["touch", "SHOULD_NOT_RUN"]
[features]
hooks = true
[mcp_servers.untrusted]
command = "SHOULD_NOT_RUN"
[model_providers.company]
name = "Company"
base_url = "https://models.example/v1"
wire_api = "responses"
http_headers = { Authorization = "Bearer TEST_SECRET" }
"#;
        fs::write(root.path().join("config.toml"), original).unwrap();
        fs::write(
            root.path().join("work.config.toml"),
            "model = 'work-model'\nmodel_reasoning_effort = 'high'",
        )
        .unwrap();
        let connection = load_from(Agent::Codex, root.path(), None).unwrap();
        assert_eq!(connection.info.model.as_deref(), Some("work-model"));
        assert_eq!(connection.info.provider.as_deref(), Some("company"));
        let mut command = Command::new("fixture");
        connection.codex_args(&mut command).unwrap();
        let args = command
            .get_args()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(args.contains("work-model") && args.contains("models.example"));
        assert!(!args.contains("TEST_SECRET") && !args.contains("SHOULD_NOT_RUN"));
        assert!(command
            .get_envs()
            .any(|(k, v)| k == "FILEPACE_AI_HEADER_0" && v.unwrap() == "Bearer TEST_SECRET"));
        assert_eq!(
            fs::read_to_string(root.path().join("config.toml")).unwrap(),
            original
        );
        assert!(load_from(Agent::Codex, root.path(), Some("../../outside")).is_err());
        assert!(load_from(Agent::Codex, root.path(), Some("missing")).is_err());
    }

    #[test]
    fn opencode_preserves_jsonc_provider_credentials_and_relative_references_only() {
        let root = tempfile::tempdir().unwrap();
        let original = r#"{
          // The user chose a compatible gateway.
          "model": "company/my-model",
          "provider": { "company": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://ai.example/v1", "apiKey": "{file:token}" } } },
          "plugin": ["SHOULD_NOT_RUN"], "mcp": { "bad": { "command": ["SHOULD_NOT_RUN"] } },
          "instructions": ["AGENTS.md"],
        }"#;
        fs::write(root.path().join("opencode.jsonc"), original).unwrap();
        let connection = load_from(Agent::Opencode, root.path(), None).unwrap();
        assert_eq!(connection.info.provider.as_deref(), Some("company"));
        assert_eq!(
            connection.values["provider"]["company"]["options"]["apiKey"],
            format!("{{file:{}}}", root.path().join("token").display())
        );
        assert!(!connection.values.to_string().contains("SHOULD_NOT_RUN"));
        assert_eq!(
            fs::read_to_string(root.path().join("opencode.jsonc")).unwrap(),
            original
        );
        fs::write(root.path().join("opencode.jsonc"), "{broken").unwrap();
        assert!(load_from(Agent::Opencode, root.path(), None).is_err());
    }

    #[test]
    fn harness_uses_selected_profile_and_credentials_without_loading_user_code() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("profiles/web")).unwrap();
        let profile = "- id: agent-default-model\n  config:\n    provider: private\n    model: saved-model\n- insert:\n    - name: malicious-plugin\n      config: !!js process.exit(99)\n";
        fs::write(root.path().join("profiles/web/cordis.patch.yml"), profile).unwrap();
        fs::write(
            root.path().join("cordis.patch.yml"),
            "- id: llm-pi-ai\n  config:\n    providers: []\n",
        )
        .unwrap();
        fs::write(root.path().join(".credentials.yaml"), "fixture: SECRET").unwrap();
        let connection = load_from(Agent::Deepseek, root.path(), Some("web")).unwrap();
        assert_eq!(connection.info.model.as_deref(), Some("saved-model"));
        let work = tempfile::tempdir().unwrap();
        let mut command = Command::new("dsh");
        connection.harness(work.path(), &mut command).unwrap();
        let generated = fs::read_to_string(
            work.path()
                .join("harness/profiles/filepace/cordis.patch.yml"),
        )
        .unwrap();
        assert!(generated.contains("saved-model") && generated.contains("dsh-headless"));
        for excluded in [
            "malicious-plugin",
            "process.exit",
            "dsh-tool-fs",
            "dsh-tool-bash",
            "dsh-tool-web",
            "dsh-plugin-manager",
            "SECRET",
        ] {
            assert!(!generated.contains(excluded), "unexpected {excluded}");
        }
        assert!(!work.path().join("harness/.credentials.yaml").exists());
        assert!(generated.contains(
            &root
                .path()
                .join(".credentials.yaml")
                .to_string_lossy()
                .to_string()
        ));
        assert_eq!(
            fs::read_to_string(root.path().join(".credentials.yaml")).unwrap(),
            "fixture: SECRET"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("profiles/web/cordis.patch.yml")).unwrap(),
            profile
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(
                    work.path()
                        .join("harness/profiles/filepace/cordis.patch.yml")
                )
                .unwrap()
                .permissions()
                .mode()
                    & 0o777,
                0o600
            );
        }
        fs::write(
            root.path().join("cordis.patch.yml"),
            "- id: agent-default-model\n  config:\n    model: !!js process.env.MODEL\n",
        )
        .unwrap();
        assert!(load_from(Agent::Deepseek, root.path(), Some("web"))
            .err()
            .unwrap()
            .contains("动态表达式"));
    }
}
