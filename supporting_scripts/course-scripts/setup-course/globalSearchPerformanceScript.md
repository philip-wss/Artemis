# Global Search: Add Weaviate performance test data generation script

### Summary

Add a comprehensive test data generation script for Weaviate global search performance testing. The script creates 20-40 courses (configurable) with realistic, theme-consistent CS content across 10 distinct topics. Each course includes exercises (all types), lectures with units, FAQs, exams, and channel messages -- providing a realistic dataset to benchmark global search performance under load.

### Motivation and Context

To validate and benchmark Weaviate global search performance, we need a large, realistic dataset that covers all searchable entity types and exercises the date-based and role-based access filters. Manual data creation is impractical at the scale needed (30+ courses with 70 exercises each), so an automated script is necessary.

### Description

**New files:**

- `supporting_scripts/course-scripts/setup-course/generate-search-data.mjs` -- Main orchestration script
- `supporting_scripts/course-scripts/setup-course/search-data/index.mjs` -- Course theme index
- `supporting_scripts/course-scripts/setup-course/search-data/*.mjs` -- 10 course theme data files

**Per course the script creates:**
- 70 exercises (40 programming, 10 text, 8 modeling, 6 quiz, 6 file-upload)
- 20 lectures with 5 units each (text, online, attachment)
- 20 FAQs
- 2 exams (1 past, 1 future) with 5 exercise groups x 3 exercises each
- 1 public channel with 15 messages

**10 CS course themes:** Software Engineering, Algorithms & Data Structures, Machine Learning, Database Systems, Computer Networks, Operating Systems, Distributed Systems, Cybersecurity, Web Development, Computer Architecture

**Key design decisions:**
- **Data-driven architecture**: Each course theme is a separate `.mjs` file (~50KB each) to keep individual file sizes manageable. A `fill()` function cycles through available data to reach target counts.
- **Date variation**: Courses alternate between past/recent/current start dates. Half the exercises per course have past release dates, half future. One exam is in the past (-60 to -45 days), one in the future (+30 to +45 days). Some courses have already ended.
- **Access filter coverage**: The date mix ensures Weaviate search filter logic for students (only released + started exams), TAs (all regular + ended exams), and editors/instructors (all) can be exercised.
- **Configurable scale**: `--courses N` flag controls the number of courses (default: 30). When N exceeds 10, themes are reused with distinct shortNames.

**Usage:**
```bash
cd supporting_scripts/course-scripts/setup-course
node generate-search-data.mjs                                    # 30 courses on localhost:8080
node generate-search-data.mjs http://localhost:8080 --courses 20  # 20 courses
node generate-search-data.mjs https://staging.example.com --courses 40
```

### Steps for Testing

Prerequisites:
- 1 Admin account (`artemis_admin`)
- A running Artemis instance with Weaviate enabled

1. Run the script against a local or test server:
   ```bash
   node generate-search-data.mjs http://localhost:8080 --courses 5
   ```
2. Verify courses are created with the expected content (exercises, lectures, FAQs, exams, channel messages)
3. Use the global search to confirm that the created content is indexed and searchable in Weaviate
4. Increase to `--courses 30` or `--courses 40` and measure search performance

### Checklist

#### General
- [ ] I tested **all** changes and their related features with **all** corresponding user types on a test server.
- [ ] Language: I followed the [guidelines for inclusive, diversity-sensitive, and appreciative language](https://docs.artemis.tum.de/developer/guidelines/language).
- [ ] I chose a title conforming to the [naming conventions for pull requests](https://docs.artemis.tum.de/developer/development-process#pr-naming-conventions).
