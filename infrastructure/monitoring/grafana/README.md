# Grafana

`kairos-overview.json` is an importable dashboard covering the metrics the API
actually exposes. Import it, pick your Prometheus datasource, done.

```bash
# Grafana on the internal network — do NOT publish 3001 to the host.
docker run -d --name kairos_grafana \
  --network kairos_internal \
  -v kairos_grafana:/var/lib/grafana \
  grafana/grafana:latest
```

Reach it over an SSH tunnel or behind Cloudflare Access. Publishing a metrics
dashboard tells anyone who finds it when your server is loaded and where the
disk pressure is, which is free reconnaissance.

## Panels, and why each is there

| Panel | What it answers |
| --- | --- |
| Request latency by endpoint | p50/p95/p99 per route, from the histograms |
| Throughput | requests/sec by status class |
| Error rate | 5xx as a fraction of traffic |
| Connection budget | how close the machine is to refusing new project pools |
| Clients waiting | the number that actually predicts an outage |
| CPU and temperature | whether "slow queries" are really thermal throttling |
| Memory and disk | the two ways a laptop server dies quietly |
| Redis | hit ratio and memory |
| Things needing attention | unverified backups, quota refusals, webhook failures |

The quantile panels use `histogram_quantile` over the same buckets the API's
own `/server/latency` endpoint reads, so Grafana and the dashboard never
disagree — which they would if each computed them separately.

Alert rules are in `../alerts.yml` and are defined in Prometheus rather than
Grafana, so alerting keeps working if Grafana is down.
