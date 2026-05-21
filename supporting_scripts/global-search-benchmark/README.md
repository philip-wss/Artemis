# Global Search Benchmark

Benchmarks the Artemis global search API (`GET /api/search`) backed by Weaviate.

The script:
1. Authenticates with Artemis as an admin user.
2. Queries Weaviate directly to record **how many entities of each type are currently ingested**.
3. Runs a configurable suite of search queries across all entity types:
   `exercise`, `lecture`, `lecture_unit`, `exam`, `faq`, `channel`, `course`, `post`, `answer_post`.
4. Measures wall-clock latency (min / max / mean / median / p95 / p99) over N iterations per query.
5. Writes a **Markdown report** to `benchmark_report_<YYYY-MM-DD_HH-MM-SS>.md`.

> **Note:** `course`, `post`, and `answer_post` require the
> `feature/development/global-search/add-courses-and-messages` feature to be
> active in the running Artemis instance. Queries for those types will succeed
> (HTTP 200, empty results) but return no hits on older server versions.

## Prerequisites

- Python 3.11 or higher
- A running Artemis instance with Weaviate enabled
- Admin credentials for the Artemis instance

## Setup

```bash
cd supporting_scripts/global-search-benchmark
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## Configuration

Edit `config.ini` to match your environment:

```ini
[Settings]
server_url = http://localhost:8080/api
admin_user = artemis_admin
admin_password = artemis_admin

[Weaviate]
# Must match artemis.weaviate.http-host / http-port / collection-prefix in application.yml
http_host = localhost
http_port = 8001
collection_prefix = Artemis_
api_key =               # leave empty when Weaviate has no authentication

[Benchmark]
iterations = 20         # calls per (query × type) combination
limit = 10              # max results requested per search call
output_dir = .          # directory for the generated report file
entity_types = exercise,lecture,lecture_unit,exam,faq,channel,course,post,answer_post
```

## Running

```bash
python3 benchmark_global_search.py
```

Override the config or output path at the command line:

```bash
python3 benchmark_global_search.py --config /path/to/other/config.ini
python3 benchmark_global_search.py --output /tmp/my_report.md
```

## Output

The script writes a Markdown file such as `benchmark_report_2025-05-21_14-30-00.md` to
the configured `output_dir`. The report contains:

| Section | Description |
|---------|-------------|
| **Environment** | Server URL, Weaviate URL, collection name, iteration count, result limit |
| **Ingested Entities in Weaviate** | Count per entity type at benchmark time, plus total |
| **Results — All Types Combined** | Latency table for `types=all` across all benchmark queries |
| **Results — Per Entity Type** | One latency table per entity type |
| **Summary Statistics** | Aggregated min/max/mean/p95/p99 across all queries |

### Example entity-count section

```markdown
## Ingested Entities in Weaviate

| Entity Type  | Count  |
|--------------|-------:|
| `exercise`   | 12 543 |
| `lecture`    |  2 187 |
| `lecture_unit` | 9 804 |
| `exam`       |    341 |
| `faq`        |    876 |
| `channel`    |  1 230 |
| `course`     |  2 000 |
| `post`       | 45 621 |
| `answer_post`| 31 048 |
| **Total**    | **105 650** |
```

## Populating Test Data

To generate a realistic dataset before benchmarking, use the companion scripts in
`../course-scripts/quick-course-setup/`:

```bash
# Create many courses with students (feeds courses into Weaviate)
cd ../course-scripts/quick-course-setup
python3 mass_course_generation.py

# Create one fully-featured course with exercises, lectures, FAQs, channels, messages
node ../setup-course/setup-course.mjs
```

Both approaches require a running Artemis instance with Weaviate enabled.
