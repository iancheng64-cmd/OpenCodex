// Stdio-only, one helper per real thread. Never expose this control protocol as a model tool.
mod config_fs;
mod dispatch;

use anyhow::{Result, Context, bail, ensure};
use codex_config::{ConfigLoadOptions, NoopThreadConfigLoader, loader::load_config_layers_state};
use codex_hooks::{Hooks, HooksConfig, HookListEntryHandler, HookMcpCall, HookMcpExecutor};
use codex_protocol::ThreadId;
use codex_utils_absolute_path::AbsolutePathBuf;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use std::{collections::HashMap, io::Write, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}};
use tokio::{io::{AsyncBufReadExt, AsyncReadExt, BufReader}, sync::oneshot, task::JoinHandle};

static TRANSPORT_BROKEN: tokio::sync::Notify = tokio::sync::Notify::const_new();
static MCP_SERIAL: AtomicU64 = AtomicU64::new(1);

fn emit(value: Value) {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    if serde_json::to_writer(&mut lock, &value).and_then(|_| { lock.write_all(b"\n").map_err(serde_json::Error::io) }).is_err()
        || lock.flush().is_err() {
        // Wake the control loop so active and background hook children are cleaned up.
        TRANSPORT_BROKEN.notify_one();
    }
}
fn reply(id: Value, result: Result<Value>) {
    match result {
        Ok(value) => emit(json!({"id":id,"result":value})),
        Err(error) => emit(json!({"id":id,"error":{"message":format!("{error:#}")}})),
    }
}
pub(crate) fn required<'a>(p: &'a Value, field: &str) -> Result<&'a str> {
    p.get(field).and_then(Value::as_str).filter(|s| !s.is_empty()).with_context(|| format!("missing {field}"))
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<String>>>>>;
struct McpRelay { pending: Pending, thread_id: String }
struct PendingCall { id: String, pending: Pending }
impl Drop for PendingCall {
    fn drop(&mut self) {
        if self.pending.lock().unwrap().remove(&self.id).is_some() {
            emit(json!({"method":"hooks/mcpCancelled","params":{"id":self.id}}));
        }
    }
}
impl HookMcpExecutor for McpRelay {
    fn execute(&self, call: HookMcpCall) -> BoxFuture<'_, Result<String>> {
        Box::pin(async move {
            let id = format!("mcp-{}", MCP_SERIAL.fetch_add(1, Ordering::Relaxed));
            let (tx, rx) = oneshot::channel();
            self.pending.lock().unwrap().insert(id.clone(), tx);
            let _guard = PendingCall { id: id.clone(), pending: self.pending.clone() };
            // The upstream core MCP executor adds this trusted routing metadata.
            // The standalone host must derive it from its owner, not a hook payload.
            let mut metadata = call.metadata.unwrap_or_default();
            metadata.insert("threadId".to_owned(), json!(self.thread_id));
            emit(json!({"method":"hooks/mcp","params":{"id":id,"threadId":self.thread_id,
                "server":call.server,"tool":call.tool,"environmentId":call.environment_id,
                "metadata":metadata,"arguments":call.input,"timeoutMs":call.timeout.as_millis()}}));
            tokio::time::timeout(call.timeout, rx).await.context("MCP hook timed out")?
                .context("MCP hook response channel closed")?
        })
    }
}
pub(crate) struct Owner {
    thread_id: ThreadId,
    session_id: ThreadId,
    cwd: AbsolutePathBuf,
    codex_home: PathBuf,
}
impl Owner {
    async fn parse(params: &Value) -> Result<Self> {
        let thread_id = ThreadId::from_string(required(params, "threadId")?).context("invalid real threadId")?;
        let session_id = match params.get("sessionId") {
            Some(_) => ThreadId::from_string(required(params, "sessionId")?).context("invalid real sessionId")?,
            None => thread_id,
        };
        let cwd = std::fs::canonicalize(required(params, "cwd")?).context("cwd unavailable")?;
        ensure!(cwd.is_dir(), "cwd is not a directory");
        let codex_home = std::fs::canonicalize(required(params, "codexHome")?).context("codexHome unavailable")?;
        ensure!(codex_home.is_dir(), "codexHome is not a directory");
        Ok(Self { thread_id, session_id, cwd: AbsolutePathBuf::try_from(cwd)?, codex_home })
    }
    async fn config(&self) -> Result<HooksConfig> {
        let stack = load_config_layers_state(&config_fs::ConfigFileSystem, &self.codex_home,
            Some(self.cwd.clone()), &[], ConfigLoadOptions::default(), &NoopThreadConfigLoader).await?;
        let effective = stack.effective_config();
        let feature_enabled = effective.get("features").and_then(|v| v.get("hooks")).and_then(|v| v.as_bool()).unwrap_or(false);
        Ok(HooksConfig { feature_enabled, config_layer_stack: Some(stack), ..Default::default() })
    }
}
struct Session {
    owner: Arc<Owner>,
    hooks: Hooks,
    pending: Pending,
    events: JoinHandle<()>,
}
impl Session {
    async fn new(owner: Arc<Owner>) -> Result<(Self, Value)> {
        let config = owner.config().await?;
        let inventory = inventory(config.clone());
        let pending = Pending::default();
        let relay = Arc::new(McpRelay { pending: pending.clone(), thread_id: owner.thread_id.to_string() });
        let (hooks, receiver) = Hooks::new(config, owner.thread_id, relay)?;
        let events = tokio::spawn(async move {
            while let Ok(event) = receiver.recv().await {
                emit(json!({"method":"hooks/completed","params":event}));
            }
        });
        Ok((Self { owner, hooks, pending, events }, inventory))
    }
    async fn close(self) {
        self.hooks.shutdown().await;
        self.pending.lock().unwrap().clear();
        self.events.abort();
        let _ = self.events.await;
    }
}
fn inventory(config: HooksConfig) -> Value {
    let enabled = config.feature_enabled;
    let result = codex_hooks::list_hooks(config);
    let hooks: Vec<Value> = result.hooks.into_iter().filter(|h| !h.builtin).map(|h| {
        let handler = match h.handler {
            HookListEntryHandler::Command { command, r#async } => json!({"type":"command","command":command,"async":r#async}),
            HookListEntryHandler::McpTool { server, tool } => json!({"type":"mcp_tool","server":server,"tool":tool}),
        };
        json!({"key":h.key,"eventName":h.event_name,"handler":handler,"matcher":h.matcher,"timeoutSec":h.timeout_sec,
            "statusMessage":h.status_message,"additionalContextLimit":h.additional_context_limit,
            "sourcePath":h.source_path,"source":h.source,"pluginId":h.plugin_id,"displayOrder":h.display_order,
            "enabled":h.enabled,"isManaged":h.is_managed,"currentHash":h.current_hash,"trustStatus":h.trust_status})
    }).collect();
    json!({"featureEnabled":enabled,"hooks":hooks,"warnings":result.warnings,
        "capabilities":{"nativeHookSemantics":true,"pluginDiscovery":false,"cloudPolicyBinding":false}})
}
struct Active { id: String, task: JoinHandle<()> }
async fn cancel(active: &mut Option<Active>, id: Option<&str>) -> bool {
    if active.as_ref().is_none_or(|a| id.is_some_and(|id| id != a.id)) { return false; }
    let active = active.take().unwrap();
    active.task.abort();
    if active.task.await.is_err_and(|e| e.is_cancelled()) {
        reply(json!(active.id), Err(anyhow::anyhow!("hook execution cancelled")));
        true
    } else { false }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut reader = BufReader::new(tokio::io::stdin());
    let mut session: Option<Session> = None;
    let mut active: Option<Active> = None;
    let mut fatal = None;
    loop {
        let mut bytes = Vec::new();
        let mut bounded = (&mut reader).take(1_048_577);
        let read = tokio::select! {
            read = bounded.read_until(b'\n', &mut bytes) => read,
            _ = TRANSPORT_BROKEN.notified() => { fatal = Some(anyhow::anyhow!("control output closed")); break; }
        };
        match read {
            Ok(0) => break,
            Ok(_) if bytes.len() > 1_048_576 => { fatal = Some(anyhow::anyhow!("control message exceeds 1 MiB")); break; }
            Err(error) => { fatal = Some(error.into()); break; }
            _ => {}
        }
        let request: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(e) => { reply(Value::Null, Err(e.into())); continue; }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let Some(request_id) = id.as_str().filter(|s| !s.is_empty() && s.len() <= 128).map(str::to_owned) else {
            reply(id, Err(anyhow::anyhow!("request id must be a nonempty string of at most 128 bytes"))); continue;
        };
        if active.as_ref().is_some_and(|a| a.task.is_finished()) {
            let finished = active.take().unwrap();
            if let Err(e) = finished.task.await { reply(json!(finished.id), Err(e.into())); }
        }
        if active.as_ref().is_some_and(|a| a.id == request_id) {
            // Do not emit a second response with an in-flight ID.
            emit(json!({"method":"hooks/protocolError","params":{"message":"duplicate active request id"}}));
            continue;
        }
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if method == "execute" {
            if active.is_some() { reply(id, Err(anyhow::anyhow!("hook execution already active"))); continue; }
            let Some(s) = session.as_ref() else { reply(id, Err(anyhow::anyhow!("init required"))); continue; };
            let owner = s.owner.clone();
            let hooks = s.hooks.clone();
            active = Some(Active { id: request_id, task: tokio::spawn(async move {
                reply(id, dispatch::execute(&owner, &hooks, params).await);
            }) });
            continue;
        }
        let result: Result<Value> = async {
            match method {
                "init" => {
                    ensure!(session.is_none(), "helper already bound to a thread");
                    let owner = Arc::new(Owner::parse(&params).await?);
                    let (s, info) = Session::new(owner).await?;
                    session = Some(s);
                    Ok(info)
                }
                "list" => {
                    let s = session.as_ref().context("init required")?;
                    Ok(inventory(s.owner.config().await?))
                }
                "reload" => {
                    ensure!(active.is_none(), "cannot reload while a hook is active");
                    let s = session.as_ref().context("init required")?;
                    let (new, info) = Session::new(s.owner.clone()).await?;
                    session.replace(new).unwrap().close().await;
                    Ok(info)
                }
                "cancel" => {
                    let execution_id = required(&params, "executionId")?;
                    Ok(json!({"cancelled":cancel(&mut active, Some(execution_id)).await}))
                }
                "mcp/response" => {
                    let s = session.as_ref().context("init required")?;
                    let callback_id = required(&params, "callbackId")?;
                    let result = if let Some(e) = params.get("error").and_then(Value::as_str) { Err(anyhow::anyhow!("{e}")) }
                        else { Ok(params.get("output").and_then(Value::as_str).context("missing output string")?.to_owned()) };
                    let tx = s.pending.lock().unwrap().remove(callback_id).context("unknown or expired callback")?;
                    tx.send(result).map_err(|_| anyhow::anyhow!("callback already cancelled"))?;
                    Ok(json!({}))
                }
                "shutdown" => {
                    cancel(&mut active, None).await;
                    if let Some(s) = session.take() { s.close().await; }
                    Ok(json!({}))
                }
                _ => bail!("unknown control method"),
            }
        }.await;
        reply(id, result);
        if method == "shutdown" { break; }
    }
    cancel(&mut active, None).await;
    if let Some(s) = session { s.close().await; }
    if let Some(error) = fatal { return Err(error); }
    Ok(())
}
