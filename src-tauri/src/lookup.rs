// IP geolocation, WHOIS, and reverse DNS lookup logic
// Extracted from main.rs for better organization

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::IpAddr;
use std::time::Duration;
use tokio::net::lookup_host;

#[derive(Debug, Deserialize)]
struct IpApiResponse {
    city: Option<String>,
    region: Option<String>,
    country_name: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    org: Option<String>,
    asn: Option<String>,
    error: Option<bool>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpWhoConnection {
    isp: Option<String>,
    org: Option<String>,
    asn: Option<i64>,
    domain: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpWhoResponse {
    success: bool,
    city: Option<String>,
    region: Option<String>,
    country: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    connection: Option<IpWhoConnection>,
    message: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct RipeSearchResponse {
    objects: Option<RipeObjects>,
}

#[derive(Debug, Deserialize, Clone)]
struct RipeObjects {
    object: Vec<RipeObject>,
}

#[derive(Debug, Deserialize, Clone)]
struct RipeObject {
    #[serde(rename = "type")]
    object_type: String,
    attributes: RipeAttributes,
}

#[derive(Debug, Deserialize, Clone)]
struct RipeAttributes {
    attribute: Vec<RipeAttribute>,
}

#[derive(Debug, Deserialize, Clone)]
struct RipeAttribute {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct GoogleDnsResponse {
    #[serde(rename = "Answer")]
    answer: Option<Vec<GoogleDnsRecord>>,
    #[serde(rename = "Authority")]
    authority: Option<Vec<GoogleDnsRecord>>,
}

#[derive(Debug, Deserialize)]
struct GoogleDnsRecord {
    data: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct RegistryWhoisEnrichment {
    provider: Option<String>,
    org: Option<String>,
    asn: Option<String>,
    domain: Option<String>,
    source: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LookupLocationResponse {
    ip: String,
    location: String,
    lat: f64,
    lng: f64,
    provider: Option<String>,
    org: Option<String>,
    asn: Option<String>,
    domain: Option<String>,
    source: String,
}

#[derive(Debug, Serialize)]
pub struct GeocodeLocationResponse {
    location: String,
    lat: f64,
    lng: f64,
}

#[derive(Debug, Deserialize)]
pub struct NominatimItem {
    display_name: Option<String>,
    lat: Option<String>,
    lon: Option<String>,
}

pub async fn resolve_host_ip(host: &str) -> Result<IpAddr, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("Host is required".into());
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }

    let mut addrs = lookup_host((host, 0))
        .await
        .map_err(|e| format!("Failed to resolve host '{host}': {e}"))?;

    addrs
        .next()
        .map(|addr| addr.ip())
        .ok_or_else(|| format!("No IP found for host '{host}'"))
}

fn build_location_label(
    city: Option<String>,
    region: Option<String>,
    country: Option<String>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    for part in [city, region, country] {
        if let Some(value) = part {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    parts.join(", ")
}

fn clean_text(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_asn_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let upper = trimmed.to_ascii_uppercase();
    if !upper.starts_with("AS") {
        return None;
    }
    let mut digits = String::new();
    for ch in upper.chars().skip(2) {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() {
        None
    } else {
        Some(format!("AS{digits}"))
    }
}

fn normalize_asn(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(parsed) = parse_asn_token(trimmed) {
        return Some(parsed);
    }
    if trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return Some(format!("AS{}", trimmed));
    }
    None
}

fn split_ipapi_org(org: Option<String>, asn: Option<String>) -> (Option<String>, Option<String>) {
    let mut org_clean = clean_text(org);
    let mut asn_clean = clean_text(asn).and_then(|value| parse_asn_token(&value).or(Some(value)));

    if let Some(text) = org_clean.clone() {
        let upper = text.to_ascii_uppercase();
        if upper.starts_with("AS") {
            let token = text.split_whitespace().next().unwrap_or("").trim();
            if asn_clean.is_none() {
                asn_clean = parse_asn_token(token);
            }
            let rest = text[token.len()..].trim();
            if rest.is_empty() {
                org_clean = None;
            } else {
                org_clean = Some(rest.to_string());
            }
        }
    }

    (org_clean, asn_clean)
}

fn select_best_location(
    ip: IpAddr,
    primary: Option<&LookupLocationResponse>,
    secondary: Option<&LookupLocationResponse>,
) -> String {
    let ip_text = ip.to_string();
    let score = |value: &str| -> usize {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed == ip_text {
            return 0;
        }
        trimmed
            .split(',')
            .filter(|part| !part.trim().is_empty())
            .count()
            * 4
            + trimmed.len()
    };

    let first = primary.map(|r| r.location.clone()).unwrap_or_default();
    let second = secondary.map(|r| r.location.clone()).unwrap_or_default();
    if score(&first) >= score(&second) {
        if first.trim().is_empty() {
            ip_text
        } else {
            first
        }
    } else if second.trim().is_empty() {
        ip_text
    } else {
        second
    }
}

fn domain_hint_from_host(host: &str) -> Option<String> {
    let trimmed = host.trim().trim_matches('.').to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.parse::<IpAddr>().is_ok() {
        return None;
    }
    if !trimmed.contains('.') {
        return None;
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
    {
        return None;
    }
    Some(trimmed)
}

fn ripe_attr_first(object: &RipeObject, name: &str) -> Option<String> {
    object
        .attributes
        .attribute
        .iter()
        .find(|attr| attr.name.eq_ignore_ascii_case(name))
        .and_then(|attr| clean_text(Some(attr.value.clone())))
}

fn ripe_attr_all(object: &RipeObject, name: &str) -> Vec<String> {
    object
        .attributes
        .attribute
        .iter()
        .filter(|attr| attr.name.eq_ignore_ascii_case(name))
        .filter_map(|attr| clean_text(Some(attr.value.clone())))
        .collect()
}

fn parse_route_prefix_len(route: &str) -> u8 {
    route
        .split('/')
        .nth(1)
        .and_then(|value| value.trim().parse::<u8>().ok())
        .unwrap_or(0)
}

fn extract_domain_from_text(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('.').to_ascii_lowercase();
    if trimmed.is_empty() {
        return None;
    }

    let mut candidate = trimmed.clone();
    if let Some((_, rhs)) = trimmed.rsplit_once('@') {
        candidate = rhs.to_string();
    }

    if !candidate.contains('.') {
        return None;
    }
    if !candidate
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
    {
        return None;
    }
    if !candidate.chars().any(|ch| ch.is_ascii_alphabetic()) {
        return None;
    }
    if candidate.ends_with("in-addr.arpa") {
        return None;
    }
    Some(candidate)
}

fn compose_sources(parts: &[&str]) -> String {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for part in parts {
        if part.trim().is_empty() {
            continue;
        }
        if seen.insert((*part).to_string()) {
            out.push((*part).to_string());
        }
    }
    if out.is_empty() {
        "unknown".to_string()
    } else {
        out.join(" + ")
    }
}

fn ptr_name_for_ip(ip: IpAddr) -> Option<String> {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            Some(format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0]))
        }
        IpAddr::V6(_) => None,
    }
}

async fn lookup_ptr_domain(client: &reqwest::Client, ip: IpAddr) -> Option<String> {
    let ptr_name = ptr_name_for_ip(ip)?;
    let response = client
        .get("https://dns.google/resolve")
        .query(&[("name", ptr_name.as_str()), ("type", "PTR")])
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: GoogleDnsResponse = response.json().await.ok()?;

    if let Some(answer) = payload.answer {
        for record in answer {
            if let Some(data) = record.data {
                if let Some(domain) = extract_domain_from_text(&data) {
                    return Some(domain);
                }
            }
        }
    }

    if let Some(authority) = payload.authority {
        for record in authority {
            let Some(data) = record.data else {
                continue;
            };
            for token in data.split_whitespace() {
                if let Some(domain) = extract_domain_from_text(token) {
                    return Some(domain);
                }
            }
        }
    }

    None
}

async fn lookup_ripe_search(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<RipeObject>, String> {
    let response = client
        .get("https://rest.db.ripe.net/search.json")
        .query(&[("query-string", query), ("flags", "no-filtering")])
        .send()
        .await
        .map_err(|e| format!("ripe.db request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("ripe.db HTTP {}", response.status()));
    }
    let payload: RipeSearchResponse = response
        .json()
        .await
        .map_err(|e| format!("ripe.db invalid response: {e}"))?;
    Ok(payload
        .objects
        .map(|objects| objects.object)
        .unwrap_or_default())
}

async fn lookup_ripe_org_details(
    client: &reqwest::Client,
    org_handle: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let objects = lookup_ripe_search(client, org_handle).await?;
    let org_object = objects.iter().find(|obj| {
        obj.object_type.eq_ignore_ascii_case("organisation")
            && ripe_attr_first(obj, "organisation")
                .map(|value| value.eq_ignore_ascii_case(org_handle))
                .unwrap_or(false)
    });

    let Some(org) = org_object else {
        return Ok((None, None));
    };

    let org_name = ripe_attr_first(org, "org-name");
    let email_domain = ripe_attr_all(org, "e-mail")
        .into_iter()
        .find_map(|email| extract_domain_from_text(&email));
    Ok((org_name, email_domain))
}

async fn lookup_via_ripe_registry(
    client: &reqwest::Client,
    ip: IpAddr,
) -> Result<RegistryWhoisEnrichment, String> {
    let objects = lookup_ripe_search(client, &ip.to_string()).await?;
    if objects.is_empty() {
        return Err("ripe.db returned no objects".to_string());
    }

    let inetnum = objects
        .iter()
        .find(|obj| obj.object_type.eq_ignore_ascii_case("inetnum"));
    let route = objects
        .iter()
        .filter(|obj| obj.object_type.eq_ignore_ascii_case("route"))
        .max_by_key(|obj| {
            ripe_attr_first(obj, "route")
                .map(|r| parse_route_prefix_len(&r))
                .unwrap_or(0)
        });

    let mut asn = route
        .and_then(|obj| ripe_attr_first(obj, "origin"))
        .and_then(|value| normalize_asn(&value));

    let mut org = None::<String>;
    let mut org_domain = None::<String>;
    if let Some(inet) = inetnum {
        if let Some(org_handle) = ripe_attr_first(inet, "org") {
            if let Ok((org_name, domain)) = lookup_ripe_org_details(client, &org_handle).await {
                org = org_name;
                org_domain = domain;
            }
        }
        if org.is_none() {
            org = ripe_attr_all(inet, "descr").into_iter().next();
        }

        if asn.is_none() {
            let maybe_from_mnt = ripe_attr_all(inet, "mnt-by")
                .into_iter()
                .find_map(|value| normalize_asn(&value));
            asn = maybe_from_mnt;
        }
    }

    let mut provider = None::<String>;
    let mut provider_domain = None::<String>;
    if let Some(asn_value) = asn.clone() {
        if let Ok(as_objects) = lookup_ripe_search(client, &asn_value).await {
            let aut_num = as_objects
                .iter()
                .find(|obj| {
                    obj.object_type.eq_ignore_ascii_case("aut-num")
                        && ripe_attr_first(obj, "aut-num")
                            .map(|v| v.eq_ignore_ascii_case(&asn_value))
                            .unwrap_or(false)
                })
                .or_else(|| {
                    as_objects
                        .iter()
                        .find(|obj| obj.object_type.eq_ignore_ascii_case("aut-num"))
                });

            if let Some(aut) = aut_num {
                if let Some(org_handle) = ripe_attr_first(aut, "org") {
                    if let Ok((org_name, domain)) =
                        lookup_ripe_org_details(client, &org_handle).await
                    {
                        provider = org_name;
                        provider_domain = domain;
                    }
                }
                if provider.is_none() {
                    provider = ripe_attr_first(aut, "as-name")
                        .or_else(|| ripe_attr_all(aut, "descr").into_iter().next());
                }
            }
        }
    }

    let domain = org_domain.or(provider_domain);
    let source = if provider.is_some() || org.is_some() || asn.is_some() || domain.is_some() {
        Some("ripe.db".to_string())
    } else {
        None
    };

    if source.is_none() {
        Err("ripe.db returned no usable ownership fields".to_string())
    } else {
        Ok(RegistryWhoisEnrichment {
            provider,
            org,
            asn,
            domain,
            source,
        })
    }
}

fn build_lookup_response(
    ip: IpAddr,
    city: Option<String>,
    region: Option<String>,
    country: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
    provider: Option<String>,
    org: Option<String>,
    asn: Option<String>,
    domain: Option<String>,
    source_name: &str,
) -> Result<LookupLocationResponse, String> {
    let lat = lat.ok_or_else(|| format!("{source_name} returned no latitude"))?;
    let lng = lng.ok_or_else(|| format!("{source_name} returned no longitude"))?;
    let mut location = build_location_label(city, region, country);
    if location.is_empty() {
        location = ip.to_string();
    }
    Ok(LookupLocationResponse {
        ip: ip.to_string(),
        location,
        lat,
        lng,
        provider,
        org,
        asn,
        domain,
        source: source_name.to_string(),
    })
}

async fn lookup_via_ipapi(
    client: &reqwest::Client,
    ip: IpAddr,
) -> Result<LookupLocationResponse, String> {
    let url = format!("https://ipapi.co/{ip}/json/");
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("ipapi.co request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("ipapi.co HTTP {}", resp.status()));
    }

    let payload: IpApiResponse = resp
        .json()
        .await
        .map_err(|e| format!("ipapi.co invalid response: {e}"))?;

    if payload.error.unwrap_or(false) {
        return Err(payload
            .reason
            .unwrap_or_else(|| "ipapi.co returned an error".to_string()));
    }

    let (org_value, asn_value) = split_ipapi_org(payload.org, payload.asn);
    let provider_value = org_value.clone();

    build_lookup_response(
        ip,
        payload.city,
        payload.region,
        payload.country_name,
        payload.latitude,
        payload.longitude,
        provider_value,
        org_value,
        asn_value,
        None,
        "ipapi.co",
    )
}

async fn lookup_via_ipwho(
    client: &reqwest::Client,
    ip: IpAddr,
) -> Result<LookupLocationResponse, String> {
    let url = format!("https://ipwho.is/{ip}");
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("ipwho.is request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("ipwho.is HTTP {}", resp.status()));
    }

    let payload: IpWhoResponse = resp
        .json()
        .await
        .map_err(|e| format!("ipwho.is invalid response: {e}"))?;

    if !payload.success {
        return Err(payload
            .message
            .unwrap_or_else(|| "ipwho.is returned an error".to_string()));
    }

    let connection = payload.connection;
    let provider = connection
        .as_ref()
        .and_then(|c| c.isp.clone().or(c.org.clone()));
    let org = connection.as_ref().and_then(|c| c.org.clone());
    let asn = connection
        .as_ref()
        .and_then(|c| c.asn)
        .map(|value| format!("AS{}", value));
    let domain = connection.as_ref().and_then(|c| c.domain.clone());

    build_lookup_response(
        ip,
        payload.city,
        payload.region,
        payload.country,
        payload.latitude,
        payload.longitude,
        provider,
        org,
        asn,
        domain,
        "ipwho.is",
    )
}

pub async fn lookup_ip_location(host: String) -> Result<LookupLocationResponse, String> {
    let ip = resolve_host_ip(&host).await?;
    let domain_hint = domain_hint_from_host(&host);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let (ipwho_result, ipapi_result, registry_result, ptr_domain) = tokio::join!(
        lookup_via_ipwho(&client, ip),
        lookup_via_ipapi(&client, ip),
        lookup_via_ripe_registry(&client, ip),
        lookup_ptr_domain(&client, ip)
    );
    let registry = registry_result.ok();

    match (ipwho_result, ipapi_result) {
        (Ok(ipwho), Ok(ipapi)) => {
            let location = select_best_location(ip, Some(&ipwho), Some(&ipapi));
            let provider = registry
                .as_ref()
                .and_then(|value| clean_text(value.provider.clone()))
                .or_else(|| clean_text(ipapi.provider.clone()))
                .or_else(|| clean_text(ipwho.provider.clone()))
                .or_else(|| clean_text(ipapi.org.clone()))
                .or_else(|| clean_text(ipwho.org.clone()));
            let org = registry
                .as_ref()
                .and_then(|value| clean_text(value.org.clone()))
                .or_else(|| clean_text(ipapi.org.clone()))
                .or_else(|| clean_text(ipwho.org.clone()))
                .or_else(|| clean_text(provider.clone()));
            let asn = registry
                .as_ref()
                .and_then(|value| clean_text(value.asn.clone()))
                .or_else(|| clean_text(ipapi.asn.clone()))
                .or_else(|| clean_text(ipwho.asn.clone()));
            let domain = domain_hint
                .clone()
                .or(ptr_domain.clone())
                .or_else(|| {
                    registry
                        .as_ref()
                        .and_then(|value| clean_text(value.domain.clone()))
                })
                .or_else(|| clean_text(ipapi.domain.clone()))
                .or_else(|| clean_text(ipwho.domain.clone()))
                .or_else(|| clean_text(ipapi.domain.clone()));
            let source = compose_sources(&[
                registry
                    .as_ref()
                    .and_then(|value| value.source.as_deref())
                    .unwrap_or(""),
                "ipwho.is",
                "ipapi.co",
                if ptr_domain.is_some() {
                    "dns.google"
                } else {
                    ""
                },
            ]);

            Ok(LookupLocationResponse {
                ip: ip.to_string(),
                location,
                lat: ipwho.lat,
                lng: ipwho.lng,
                provider,
                org,
                asn,
                domain,
                source,
            })
        }
        (Ok(mut ipwho), Err(_)) => {
            ipwho.provider = registry
                .as_ref()
                .and_then(|value| clean_text(value.provider.clone()))
                .or_else(|| clean_text(ipwho.provider.clone()))
                .or_else(|| clean_text(ipwho.org.clone()));
            ipwho.org = registry
                .as_ref()
                .and_then(|value| clean_text(value.org.clone()))
                .or_else(|| clean_text(ipwho.org.clone()))
                .or_else(|| clean_text(ipwho.provider.clone()));
            ipwho.asn = registry
                .as_ref()
                .and_then(|value| clean_text(value.asn.clone()))
                .or_else(|| clean_text(ipwho.asn.clone()));
            ipwho.domain = domain_hint
                .clone()
                .or(ptr_domain.clone())
                .or_else(|| {
                    registry
                        .as_ref()
                        .and_then(|value| clean_text(value.domain.clone()))
                })
                .or_else(|| clean_text(ipwho.domain.clone()));
            ipwho.source = compose_sources(&[
                registry
                    .as_ref()
                    .and_then(|value| value.source.as_deref())
                    .unwrap_or(""),
                "ipwho.is",
                if ptr_domain.is_some() {
                    "dns.google"
                } else {
                    ""
                },
            ]);
            Ok(ipwho)
        }
        (Err(_), Ok(mut ipapi)) => {
            ipapi.provider = registry
                .as_ref()
                .and_then(|value| clean_text(value.provider.clone()))
                .or_else(|| clean_text(ipapi.provider.clone()))
                .or_else(|| clean_text(ipapi.org.clone()));
            ipapi.org = registry
                .as_ref()
                .and_then(|value| clean_text(value.org.clone()))
                .or_else(|| clean_text(ipapi.org.clone()))
                .or_else(|| clean_text(ipapi.provider.clone()));
            ipapi.asn = registry
                .as_ref()
                .and_then(|value| clean_text(value.asn.clone()))
                .or_else(|| clean_text(ipapi.asn.clone()));
            ipapi.domain = domain_hint
                .clone()
                .or(ptr_domain.clone())
                .or_else(|| {
                    registry
                        .as_ref()
                        .and_then(|value| clean_text(value.domain.clone()))
                })
                .or_else(|| clean_text(ipapi.domain.clone()));
            ipapi.source = compose_sources(&[
                registry
                    .as_ref()
                    .and_then(|value| value.source.as_deref())
                    .unwrap_or(""),
                "ipapi.co",
                if ptr_domain.is_some() {
                    "dns.google"
                } else {
                    ""
                },
            ]);
            Ok(ipapi)
        }
        (Err(ipwho_error), Err(ipapi_error)) => Err(format!(
            "All geo lookup providers failed (ipwho.is: {ipwho_error}; ipapi.co: {ipapi_error})"
        )),
    }
}

pub async fn geocode_location(query: String) -> Result<GeocodeLocationResponse, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Location query is required".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let resp = client
        .get("https://nominatim.openstreetmap.org/search")
        .header("User-Agent", "TermiNox/2.0 (desktop app geocoder)")
        .query(&[
            ("q", query),
            ("format", "jsonv2"),
            ("limit", "1"),
            ("addressdetails", "1"),
        ])
        .send()
        .await
        .map_err(|e| format!("Nominatim request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Nominatim HTTP {}", resp.status()));
    }

    let rows: Vec<NominatimItem> = resp
        .json()
        .await
        .map_err(|e| format!("Nominatim invalid response: {e}"))?;

    let first = rows
        .first()
        .ok_or_else(|| format!("No location match found for '{query}'"))?;

    let lat = first
        .lat
        .as_deref()
        .ok_or_else(|| "Geocoder returned no latitude".to_string())?
        .parse::<f64>()
        .map_err(|e| format!("Invalid latitude from geocoder: {e}"))?;

    let lng = first
        .lon
        .as_deref()
        .ok_or_else(|| "Geocoder returned no longitude".to_string())?
        .parse::<f64>()
        .map_err(|e| format!("Invalid longitude from geocoder: {e}"))?;

    let location = first
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(query)
        .to_string();

    Ok(GeocodeLocationResponse { location, lat, lng })
}
