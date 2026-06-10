use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use russh::client;
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;

use crate::config::ServerConfig;
use super::common::{ClientHandler, connect_authenticated};

#[derive(Debug, Serialize)]
pub struct ServerMetricsSnapshot {
    pub hostname: String,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub os_pretty: Option<String>,
    pub kernel: Option<String>,
    pub cpu_cores: Option<u32>,
    pub memory_total_mb: Option<u32>,
    pub uptime_seconds: Option<u64>,
    pub cpu_used_percent: Option<f64>,
    pub memory_used_percent: Option<f64>,
    pub disk_used_percent: Option<f64>,
    pub services: Vec<ServiceEndpoint>,
    pub services_error: Option<String>,
    pub fetched_unix_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ServiceEndpoint {
    pub protocol: String,
    pub bind: String,
    pub port: u16,
    pub service: String,
    pub process: Option<String>,
    pub is_browser_supported: bool,
    pub browser_url_scheme: Option<String>,
}

struct ExecResult {
    stdout: String,
    stderr: String,
    exit_status: Option<u32>,
}

const LINUX_PROBE_COMMAND: &str = r#"sh -lc "
HOSTNAME=\$(hostname 2>/dev/null || uname -n 2>/dev/null || echo unknown)
if [ -r /etc/os-release ]; then
  . /etc/os-release
fi
OS_NAME=\${NAME:-\$(uname -s 2>/dev/null || echo Linux)}
OS_VERSION=\${VERSION_ID:-\${VERSION:-unknown}}
OS_PRETTY=\${PRETTY_NAME:-\$OS_NAME \$OS_VERSION}
KERNEL=\$(uname -r 2>/dev/null || echo unknown)
CORES=\$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo '')
UPTIME=\$(awk '{print int(\$1)}' /proc/uptime 2>/dev/null || echo 0)
CPU=\$(LC_ALL=C top -bn1 2>/dev/null | awk -F'[, ]+' '/Cpu\\(s\\)|%Cpu/{for(i=1;i<=NF;i++){if(\$i ~ /id/){print int(100-\$(i-1)); exit}}}')
MEM_TOTAL=\$(free -m 2>/dev/null | awk '/Mem:/{print \$2}')
MEM=\$(free -m 2>/dev/null | awk '/Mem:/{if(\$2>0) printf \"%d\", (\$3*100)/\$2}')
DISK=\$(df -P / 2>/dev/null | awk 'NR==2{gsub(/%/,\"\",\$5); print \$5}')
printf \"hostname=%s\nos_name=%s\nos_version=%s\nos_pretty=%s\nkernel=%s\ncpu_cores=%s\nmemory_total_mb=%s\nuptime_seconds=%s\ncpu_used_percent=%s\nmemory_used_percent=%s\ndisk_used_percent=%s\n\" \"\$HOSTNAME\" \"\$OS_NAME\" \"\$OS_VERSION\" \"\$OS_PRETTY\" \"\$KERNEL\" \"\$CORES\" \"\$MEM_TOTAL\" \"\$UPTIME\" \"\$CPU\" \"\$MEM\" \"\$DISK\"
""#;

const WINDOWS_PROBE_COMMAND: &str = r#"powershell -NoProfile -NonInteractive -Command "$os = Get-CimInstance Win32_OperatingSystem; $sys = Get-CimInstance Win32_ComputerSystem; $disk = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\" | Select-Object -First 1; $uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds; $memTotalMb = [int]($os.TotalVisibleMemorySize / 1024); $memUsedPct = ''; if ($os.TotalVisibleMemorySize -gt 0) { $memUsedPct = [int]((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100); }; $diskPct = ''; if ($disk -and $disk.Size -gt 0) { $diskPct = [int](100 - (($disk.FreeSpace / $disk.Size) * 100)); }; Write-Output ('hostname=' + $env:COMPUTERNAME); Write-Output ('os_name=' + $os.Caption); Write-Output ('os_version=' + $os.Version); Write-Output ('os_pretty=' + $os.Caption + ' ' + $os.Version); Write-Output ('kernel=' + $os.BuildNumber); Write-Output ('cpu_cores=' + $sys.NumberOfLogicalProcessors); Write-Output ('memory_total_mb=' + $memTotalMb); Write-Output ('uptime_seconds=' + $uptime); Write-Output 'cpu_used_percent='; Write-Output ('memory_used_percent=' + $memUsedPct); Write-Output ('disk_used_percent=' + $diskPct)" "#;

const LINUX_SERVICES_COMMAND: &str = r#"sh -lc "
if command -v ss >/dev/null 2>&1; then
  ss -lntupH 2>/dev/null || ss -lntuH 2>/dev/null
elif command -v netstat >/dev/null 2>&1; then
  netstat -lntu 2>/dev/null
else
  echo __NO_SERVICE_TOOL__
fi
""#;

const WINDOWS_SERVICES_COMMAND: &str = r#"powershell -NoProfile -NonInteractive -Command "$ErrorActionPreference='SilentlyContinue'; if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) { Get-NetTCPConnection -State Listen | Sort-Object LocalPort | ForEach-Object { $proc=''; if ($_.OwningProcess) { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p) { $proc = $p.ProcessName } }; Write-Output ('proto=tcp;bind=' + $_.LocalAddress + ';port=' + $_.LocalPort + ';process=' + $proc) } }""#;

const WINDOWS_SERVICES_FALLBACK_COMMAND: &str =
    r#"cmd /C "netstat -ano -p tcp | findstr LISTENING""#;



async fn run_exec_capture(
    session: &client::Handle<ClientHandler>,
    command: &str,
) -> Result<ExecResult> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to open probe channel: {}", e))?;

    channel
        .exec(true, command)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to execute probe command: {}", e))?;

    let mut stdout = Vec::<u8>::new();
    let mut stderr = Vec::<u8>::new();
    let mut exit_status: Option<u32> = None;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => stdout.extend_from_slice(data.as_ref()),
            ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(data.as_ref()),
            ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
            ChannelMsg::Close | ChannelMsg::Eof => break,
            _ => {}
        }
    }

    let _ = channel.close().await;

    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        exit_status,
    })
}

fn parse_probe_output(output: &str) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for line in output.lines() {
        if let Some((k, v)) = line.split_once('=') {
            result.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    result
}

fn non_empty(map: &HashMap<String, String>, key: &str) -> Option<String> {
    map.get(key).and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_u64(map: &HashMap<String, String>, key: &str) -> Option<u64> {
    non_empty(map, key)?.parse::<u64>().ok()
}

fn parse_f64(map: &HashMap<String, String>, key: &str) -> Option<f64> {
    non_empty(map, key)?.parse::<f64>().ok()
}

fn parse_u32(map: &HashMap<String, String>, key: &str) -> Option<u32> {
    non_empty(map, key)?.parse::<u32>().ok()
}

fn looks_valid_probe(map: &HashMap<String, String>) -> bool {
    non_empty(map, "hostname").is_some()
        && (non_empty(map, "os_name").is_some() || non_empty(map, "os_pretty").is_some())
}

fn probe_looks_windows(map: &HashMap<String, String>) -> bool {
    let os_name = non_empty(map, "os_name").unwrap_or_default();
    let os_pretty = non_empty(map, "os_pretty").unwrap_or_default();
    let combined = format!("{os_name} {os_pretty}").to_ascii_lowercase();
    combined.contains("windows")
}

fn compact_error(text: &str) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.len() > 180 {
        let shortened = compact.chars().take(177).collect::<String>();
        format!("{shortened}...")
    } else {
        compact
    }
}

fn normalize_bind(raw: &str) -> String {
    let mut bind = raw
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .to_string();
    if let Some((base, _)) = bind.split_once('%') {
        bind = base.to_string();
    }
    let lowered = bind.to_ascii_lowercase();
    if bind.is_empty() || bind == "*" || lowered == "0.0.0.0" || lowered == "::" {
        "*".to_string()
    } else {
        bind
    }
}

fn parse_bind_port_token(token: &str) -> Option<(String, u16)> {
    let trimmed = token.trim().trim_end_matches(',');
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with('[') {
        let end = trimmed.find(']')?;
        let host = &trimmed[1..end];
        let rest = trimmed.get(end + 1..)?.trim();
        let port = rest.strip_prefix(':')?.parse::<u16>().ok()?;
        return Some((normalize_bind(host), port));
    }

    let mut parts = trimmed.rsplitn(2, ':');
    let port_part = parts.next()?.trim();
    if port_part.is_empty() || port_part == "*" {
        return None;
    }
    let port = port_part.parse::<u16>().ok()?;
    let bind_part = parts.next().unwrap_or("*").trim();
    Some((normalize_bind(bind_part), port))
}

fn browser_scheme_for_port(port: u16) -> Option<&'static str> {
    match port {
        443 | 6443 | 8443 | 9443 => Some("https"),
        80 | 81 | 3000 | 3001 | 4000 | 5000 | 5173 | 5601 | 8000 | 8080 | 8081 | 8088 | 8888
        | 9000 | 9090 | 9200 | 15672 => Some("http"),
        _ => None,
    }
}

fn service_name_for_port(port: u16) -> &'static str {
    match port {
        20 | 21 => "FTP",
        22 => "SSH",
        23 => "Telnet",
        25 => "SMTP",
        53 => "DNS",
        80 => "HTTP",
        88 => "Kerberos",
        110 => "POP3",
        123 => "NTP",
        143 => "IMAP",
        389 => "LDAP",
        443 => "HTTPS",
        445 => "SMB",
        465 => "SMTPS",
        587 => "Submission SMTP",
        631 => "IPP",
        636 => "LDAPS",
        873 => "Rsync",
        993 => "IMAPS",
        995 => "POP3S",
        1433 => "MSSQL",
        1521 => "Oracle DB",
        2049 => "NFS",
        2375 | 2376 => "Docker API",
        3306 => "MySQL",
        3389 => "RDP",
        5432 => "PostgreSQL",
        5601 => "Kibana",
        6379 => "Redis",
        6443 => "Kubernetes API",
        8080 | 8081 | 8088 => "HTTP Alt",
        8443 => "HTTPS Alt",
        8888 => "Web UI",
        9000 => "Web/Admin",
        9090 => "Prometheus",
        9200 => "Elasticsearch",
        15672 => "RabbitMQ UI",
        27017 => "MongoDB",
        _ => "Custom Service",
    }
}

fn extract_linux_process(line: &str) -> Option<String> {
    let marker = "users:((\"";
    let start = line.find(marker)?;
    let rest = &line[start + marker.len()..];
    let end = rest.find('"')?;
    let process = rest[..end].trim();
    if process.is_empty() {
        None
    } else {
        Some(process.to_string())
    }
}

fn build_service_endpoint(
    protocol: &str,
    bind: String,
    port: u16,
    process: Option<String>,
) -> ServiceEndpoint {
    let protocol_lower = protocol.trim().to_ascii_lowercase();
    let process_clean = process.and_then(|p| {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let service = process_clean
        .clone()
        .unwrap_or_else(|| service_name_for_port(port).to_string());
    let browser_url_scheme = if protocol_lower == "tcp" {
        browser_scheme_for_port(port).map(str::to_string)
    } else {
        None
    };
    let is_browser_supported = browser_url_scheme.is_some();

    ServiceEndpoint {
        protocol: protocol_lower,
        bind,
        port,
        service,
        process: process_clean,
        is_browser_supported,
        browser_url_scheme,
    }
}

fn push_unique_service(
    list: &mut Vec<ServiceEndpoint>,
    seen: &mut HashSet<String>,
    endpoint: ServiceEndpoint,
) {
    let key = format!("{}|{}|{}", endpoint.protocol, endpoint.bind, endpoint.port);
    if seen.insert(key) {
        list.push(endpoint);
    }
}

fn parse_linux_services(output: &str) -> Vec<ServiceEndpoint> {
    let mut services = Vec::new();
    let mut seen = HashSet::new();

    for raw in output.lines() {
        let line = raw.trim();
        if line.is_empty()
            || line == "__NO_SERVICE_TOOL__"
            || line.to_ascii_lowercase().starts_with("proto")
        {
            continue;
        }

        let lower = line.to_ascii_lowercase();
        let protocol = if lower.starts_with("tcp") {
            "tcp"
        } else if lower.starts_with("udp") {
            "udp"
        } else {
            continue;
        };

        let mut local_addr = None;
        for token in line.split_whitespace().skip(1) {
            if let Some((bind, port)) = parse_bind_port_token(token) {
                local_addr = Some((bind, port));
                break;
            }
        }
        let (bind, port) = match local_addr {
            Some(value) => value,
            None => continue,
        };

        let process = extract_linux_process(line);
        let endpoint = build_service_endpoint(protocol, bind, port, process);
        push_unique_service(&mut services, &mut seen, endpoint);
    }

    services.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then_with(|| a.protocol.cmp(&b.protocol))
            .then_with(|| a.bind.cmp(&b.bind))
    });
    services.truncate(64);
    services
}

fn parse_windows_kv_service(line: &str) -> Option<ServiceEndpoint> {
    let trimmed = line.trim();
    if !trimmed.starts_with("proto=") {
        return None;
    }

    let mut protocol = None::<String>;
    let mut bind = None::<String>;
    let mut port = None::<u16>;
    let mut process = None::<String>;

    for part in trimmed.split(';') {
        let (key, value) = match part.split_once('=') {
            Some(pair) => pair,
            None => continue,
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "proto" => protocol = Some(value.to_ascii_lowercase()),
            "bind" => bind = Some(normalize_bind(value)),
            "port" => port = value.parse::<u16>().ok(),
            "process" => {
                if !value.is_empty() {
                    process = Some(value.to_string());
                }
            }
            _ => {}
        }
    }

    let protocol = protocol.unwrap_or_else(|| "tcp".to_string());
    let bind = bind.unwrap_or_else(|| "*".to_string());
    let port = port?;

    Some(build_service_endpoint(&protocol, bind, port, process))
}

fn parse_windows_netstat_service(line: &str) -> Option<ServiceEndpoint> {
    let trimmed = line.trim();
    let upper = trimmed.to_ascii_uppercase();
    if !(upper.starts_with("TCP ") || upper.starts_with("UDP ")) {
        return None;
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }

    let protocol = parts[0].to_ascii_lowercase();
    if protocol == "tcp"
        && !parts
            .iter()
            .any(|item| item.eq_ignore_ascii_case("LISTENING"))
    {
        return None;
    }

    let local = *parts.get(1)?;
    let (bind, port) = parse_bind_port_token(local)?;
    let process = parts.last().and_then(|value| {
        if value.chars().all(|ch| ch.is_ascii_digit()) {
            Some(format!("pid {}", value))
        } else {
            None
        }
    });

    Some(build_service_endpoint(&protocol, bind, port, process))
}

fn parse_windows_services(output: &str) -> Vec<ServiceEndpoint> {
    let mut services = Vec::new();
    let mut seen = HashSet::new();

    for raw in output.lines() {
        if let Some(endpoint) =
            parse_windows_kv_service(raw).or_else(|| parse_windows_netstat_service(raw))
        {
            push_unique_service(&mut services, &mut seen, endpoint);
        }
    }

    services.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then_with(|| a.protocol.cmp(&b.protocol))
            .then_with(|| a.bind.cmp(&b.bind))
    });
    services.truncate(64);
    services
}

async fn collect_open_services(
    session: &client::Handle<ClientHandler>,
    is_windows_target: bool,
) -> Result<Vec<ServiceEndpoint>> {
    if is_windows_target {
        let windows_exec = run_exec_capture(session, WINDOWS_SERVICES_COMMAND).await?;
        let mut services = parse_windows_services(&windows_exec.stdout);
        if services.is_empty() {
            let fallback_exec =
                run_exec_capture(session, WINDOWS_SERVICES_FALLBACK_COMMAND).await?;
            services = parse_windows_services(&fallback_exec.stdout);
        }
        Ok(services)
    } else {
        let linux_exec = run_exec_capture(session, LINUX_SERVICES_COMMAND).await?;
        if linux_exec.stdout.contains("__NO_SERVICE_TOOL__") {
            anyhow::bail!("No socket inspection tool found on remote host");
        }
        Ok(parse_linux_services(&linux_exec.stdout))
    }
}

fn now_unix_ms() -> u64 {
    let ms_u128 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(ms_u128).unwrap_or(u64::MAX)
}

pub async fn collect_metrics(config: &ServerConfig) -> Result<ServerMetricsSnapshot> {
    let session = connect_authenticated(config).await?;

    let linux_exec = run_exec_capture(&session, LINUX_PROBE_COMMAND).await;

    let data = match linux_exec {
        Ok(linux_result) => {
            let linux_map = parse_probe_output(&linux_result.stdout);
            if looks_valid_probe(&linux_map) {
                linux_map
            } else {
                let windows_exec = run_exec_capture(&session, WINDOWS_PROBE_COMMAND).await?;
                let windows_map = parse_probe_output(&windows_exec.stdout);
                if looks_valid_probe(&windows_map) {
                    windows_map
                } else {
                    anyhow::bail!(
                        "Probe command returned no usable metrics (linux exit: {:?}, windows exit: {:?})",
                        linux_result.exit_status,
                        windows_exec.exit_status
                    );
                }
            }
        }
        Err(linux_err) => {
            let windows_exec = run_exec_capture(&session, WINDOWS_PROBE_COMMAND).await;
            match windows_exec {
                Ok(result) => {
                    let map = parse_probe_output(&result.stdout);
                    if looks_valid_probe(&map) {
                        map
                    } else {
                        anyhow::bail!(
                            "Probe failed for linux and windows styles (linux: {}; windows exit: {:?}, stderr: {})",
                            linux_err,
                            result.exit_status,
                            result.stderr.trim()
                        );
                    }
                }
                Err(win_err) => {
                    anyhow::bail!(
                        "Probe command failed for linux and windows styles (linux: {}; windows: {})",
                        linux_err,
                        win_err
                    );
                }
            }
        }
    };

    let is_windows_target = probe_looks_windows(&data);
    let (services, services_error) = match collect_open_services(&session, is_windows_target).await
    {
        Ok(list) => (list, None),
        Err(err) => (Vec::new(), Some(compact_error(&err.to_string()))),
    };

    let _ = session
        .disconnect(Disconnect::ByApplication, "probe complete", "en-US")
        .await;

    Ok(ServerMetricsSnapshot {
        hostname: non_empty(&data, "hostname").unwrap_or_else(|| config.host.clone()),
        os_name: non_empty(&data, "os_name"),
        os_version: non_empty(&data, "os_version"),
        os_pretty: non_empty(&data, "os_pretty"),
        kernel: non_empty(&data, "kernel"),
        cpu_cores: parse_u32(&data, "cpu_cores"),
        memory_total_mb: parse_u32(&data, "memory_total_mb"),
        uptime_seconds: parse_u64(&data, "uptime_seconds"),
        cpu_used_percent: parse_f64(&data, "cpu_used_percent"),
        memory_used_percent: parse_f64(&data, "memory_used_percent"),
        disk_used_percent: parse_f64(&data, "disk_used_percent"),
        services,
        services_error,
        fetched_unix_ms: now_unix_ms(),
    })
}
