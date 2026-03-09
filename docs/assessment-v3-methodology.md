# Skillset Assessment v3 — Methodology & Prompts

## Overview

Assessment Pipeline v3 evaluates candidates against job strategy criteria using 6 parallel assessment groups. Each criterion gets a `final_fit` value (true / partially / false), which is then scored with weights based on requirement type.

This document captures the complete logic used in the `3JD_chek` sheet evaluation of 46 candidates across 3 jobs (March 2026).

---

## 1. Assessment Groups (6 Parallel Prompts)

### 1.1 Core Experience
Evaluates `previous_role` and `responsibilities` using a 6-level "Levels of Work" framework:

| Level | Description |
|-------|-------------|
| Hands On | Execution-focused |
| Diagnosis | Problem-solving |
| Systems | Process design |
| Integration of Systems | Cross-functional |
| Business | Strategic outcomes |
| Global | Ecosystem-wide |

**Gates:**
- Overqualification: if delta between candidate LoW and job LoW >= +2, result = `false`
- Time span windows by level: Hands On/Diagnosis/Systems = 5 years; Integration = 7 years; Business = 10 years; Global = 15 years

### 1.2 Skills & Knowledge
Assesses required skills with strict `partially` criteria:
> "Requires POSITIVE evidence of something related. There must be a specific skill, project, or responsibility you can point to."

Without such evidence, returns `false`, not `partially`.

### 1.3 Experience Quantitative
Three subsections:
- **Total years:** Tolerant ranges (minimum x 0.9 to maximum x 1.3); flags over-experience (x2, x3)
- **Context experience:** Direct or strong indirect evidence
- **Industry fit:** Narrow matching with consulting/vendor implied evidence

### 1.4 People Management
Direct management focus (not dotted-line):
- **Team size:** `partially` up to 2x smaller than required
- **Composition:** Explicit or inferred (same team complexity level)

### 1.5 Education & Credentials
**Critical v3 change:** Missing education data = `partially` (not `false`).
> "No data ≠ absence of education."

Degree equivalencies:
- Master <-> Specialist
- PhD <-> Candidate of Sciences
- LLM <-> Master

### 1.6 Logistics & Preferences

**Languages (enhanced):** Five implied evidence sources:
1. CV language
2. Work location years
3. Education
4. Cultural markers
5. International company context

Proficiency matching: Exactly 1 step below required = `partially`; 2+ steps below = `false`.

**Timezone:** Deterministic UTC offset table. Tolerance: within range = `true`; 1-2 hours outside = `partially`; 3+ hours = `false`.

---

## 2. Scoring Formula

### 2.1 Fit Values

| final_fit | Numeric Value |
|-----------|--------------|
| true | 1.0 |
| partially | 0.5 |
| false | 0.0 |

### 2.2 Weights

| Requirement Type | Base Weight | x Critical | x Important |
|-----------------|-------------|------------|-------------|
| must_have | 1.5 | x 2.0 = 3.0 | x 1.33 = 2.0 |
| nice_to_have | 0.5 | x 1.0 = 0.5 | x 0.67 = 0.33 |
| responsibilities | 1.5 (minimum) | — | — |

### 2.3 Score Calculation

```
weighted_sum = SUM(fit_value[i] * weight[i])  for each criterion i
max_possible = SUM(weight[i])                  for each criterion i (assuming all true)

score = (weighted_sum / max_possible) * 100
```

### 2.4 Base Score (without Responsibilities)

Calculated the same way but excluding all `responsibilities` segment criteria. Used for the Responsibilities Cap check.

---

## 3. Decision Thresholds

| Decision | Conditions |
|----------|-----------|
| **MATCH** | (score >= 65 AND zero false must-haves) OR (score >= 75 AND <= 1 false must-have AND must-have ratio >= 0.7) |
| **PARTIAL_MATCH** | (score >= 45 AND <= 2 false must-haves) OR (score >= 35 AND zero false must-haves) |
| **NO_MATCH** | All other cases |

### Must-Have Ratio
```
must_have_ratio = count(must_have where fit=true) / count(all must_have criteria)
```

---

## 4. Responsibilities Cap (v3 Innovation)

Responsibilities blocks cannot rescue candidates with critical failures:

1. Calculate `base_score` (score without responsibilities)
2. If `base_score < 35` → decision cannot exceed NO_MATCH
3. If any critical must-have = `false` → responsibilities cannot elevate decision to MATCH

This prevents generic responsibility descriptions from masking fundamental mismatches.

---

## 5. Implementation (Python)

```python
def calc_v3_score(assessment):
    fit_values = {'true': 1.0, 'partially': 0.5, 'false': 0.0}
    weights = {'must_have': 1.5, 'nice_to_have': 0.5}

    # Separate responsibilities from other criteria
    resp_items = [a for a in assessment if a['segment'] == 'responsibilities']
    other_items = [a for a in assessment if a['segment'] != 'responsibilities']

    total_weighted = 0
    max_weighted = 0
    false_must_haves = 0
    must_have_true = 0
    must_have_total = 0

    # Score without responsibilities (for cap check)
    base_weighted = 0
    base_max = 0

    for item in other_items:
        w = weights.get(item['requirement'], 1.0)
        val = fit_values.get(item['fit'], 0.0)
        base_weighted += val * w
        base_max += w

        if item['requirement'] == 'must_have':
            must_have_total += 1
            if item['fit'] == 'true':
                must_have_true += 1
            elif item['fit'] == 'false':
                false_must_haves += 1

    # Add responsibilities (weight = 1.5 each)
    for item in resp_items:
        val = fit_values.get(item['fit'], 0.0)
        total_weighted += val * 1.5
        max_weighted += 1.5

    total_weighted += base_weighted
    max_weighted += base_max

    score = (total_weighted / max_weighted * 100) if max_weighted > 0 else 0
    base_score = (base_weighted / base_max * 100) if base_max > 0 else 0
    must_have_ratio = must_have_true / must_have_total if must_have_total > 0 else 0

    # Decision logic
    verdict = 'NO_MATCH'

    if (score >= 65 and false_must_haves == 0) or \
       (score >= 75 and false_must_haves <= 1 and must_have_ratio >= 0.7):
        verdict = 'MATCH'
    elif (score >= 45 and false_must_haves <= 2) or \
         (score >= 35 and false_must_haves == 0):
        verdict = 'PARTIAL_MATCH'

    # Responsibilities cap
    if base_score < 35:
        verdict = 'NO_MATCH'

    return {
        'score': round(score, 1),
        'base_score': round(base_score, 1),
        'verdict': verdict,
        'false_must_haves': false_must_haves,
        'must_have_ratio': round(must_have_ratio, 2)
    }
```

---

## 6. Data Pipeline

### 6.1 Source
- Platform: `platform.skillset.ae`
- API: `core.skillset.ae/api/app/jobs/`
- Auth: `x-access-token` header (session token from browser)

### 6.2 Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `POST /jobs/detail` | Get job title, company |
| `POST /jobs/candidates/list` | Get candidate list with `{filter: {jobId, stage: "pool"}, nav: {offset, limit}}` |
| `POST /jobs/candidates/detail` | Get candidate CV + assessment with `{jobCandidateId}` |

### 6.3 Assessment Data Structure

Each candidate's assessment contains an array of results:

```json
{
  "segment": "skill",
  "key": ["Talent Acquisition Strategy Development"],
  "requirement": "must_have",
  "final_fit": "true",
  "reasoning": "The candidate repeatedly owned and executed..."
}
```

Segments: `location`, `previous_role`, `education_degree`, `field_of_study`, `industry`, `skill`, `language`, `total_experience`, `context_experience`, `people_management_composition`, `responsibilities`, `work_format`, `employment_type`, `certification`, `companies`, `region`

---

## 7. Jobs Evaluated (March 2026)

| Job ID | Title | Company | Candidates in Pool |
|--------|-------|---------|-------------------|
| 103834 | Manager-Talent Acquisition | Damac | 25 |
| 92603 | Product Manager | Astra Tech | 11 |
| 91473 | Client Accountant | Bazaar Accounting | 10 |

### Results Summary

**Job 1: TA Manager @ Damac**
- v3 MATCH: 17 | Platform MATCH: 7
- v3 PARTIAL: 6 | Platform PARTIAL: 12
- v3 NO_MATCH: 2 | Platform NO_MATCH: 6

**Job 2: Product Manager @ Astra Tech**
- v3 MATCH: 9 | Platform MATCH: 3
- v3 PARTIAL: 2 | Platform PARTIAL: 6
- v3 NO_MATCH: 0 | Platform NO_MATCH: 2

**Job 3: Client Accountant @ Bazaar Accounting**
- v3 MATCH: 5 | Platform MATCH: 1
- v3 PARTIAL: 3 | Platform PARTIAL: 7
- v3 NO_MATCH: 2 | Platform NO_MATCH: 2

### Key Observation

v3 is significantly more generous than the platform. The main driver: v3 uses a pure score-based threshold (>=65% with 0 false must-haves = MATCH), while the platform appears to use additional undocumented signals that keep more candidates in PARTIAL_MATCH.

---

## 8. Output

Results written to Google Sheet:
- **Spreadsheet**: `1fdG9_4dSA14S2uilDqs7naV3LJ_4HVwGZyKsb_5UPjg`
- **Sheet**: `3JD_chek`
- **Columns**: #, Candidate, Platform Verdict, [criteria with fit indicators], v3 Score %, Base Score %, False MH, MH Ratio, v3 Verdict, Agree?

Color coding:
- Criteria headers: pink = Must Have, blue = Nice to Have
- Verdict cells: green = MATCH, yellow = PARTIAL_MATCH, red = NO_MATCH
- Failed criteria cells (false): light red background
- Agree? column: shows if v3 verdict matches platform verdict

---

## 9. v3.1 — Responsibilities as Critical Must-Have

Based on Olya's feedback: responsibilities should be treated as a critical must-have with high priority.

**Changes from v3:**
- Responsibilities weight: 1.5 -> 3.0 (critical must-have)
- Responsibilities `false` counts as a false must-have (blocks MATCH)
- Responsibilities `partially` counts toward must-have ratio

This creates differentiation within verdict groups based on responsibilities fit.

---

## 10. v4 — Calibrated Against Expert Evaluations

Olya (senior recruiter) manually evaluated 37 of 46 candidates. v3.1 agreed with her in 28/37 cases (75.7%). All 9 disagreements were v3.1 being MORE lenient than Olya.

### 10.1 Analysis of Disagreements

| Pattern | Count | Examples |
|---------|-------|---------|
| `previous_role(MH) = partially` but verdict = MATCH | 4 | Oumaima, Ahmed, Ali Mirza, Anil Paul |
| Score 65-70% but verdict = MATCH | 1 | Syed Huzaifa (69.7%) |
| AI marked criteria `true` but Olya disagrees with assessment quality | 2 | Natia (role marked true, but "tasks were administrative"), Nikos ("overqualified") |
| `resp = partially` with other weak signals | 2 | Gowrishankar, Rayan |

### 10.2 Variants Tested

15 scoring approaches evaluated:
- Weight adjustments (MH partially = 0.3, role weight = 3.0)
- Threshold changes (MATCH >= 70%, 75%, 80%)
- MH partially counting as 0.5 false MH
- Stricter PARTIAL_MATCH (max 1 false MH)
- Rule-based caps (role/resp blocking MATCH)
- Combinations of the above

**Key finding:** Aggressive weight/threshold changes fix some disagreements but BREAK existing agreements 1:1, resulting in no net improvement. Only rule-based caps produce clean gains.

### 10.3 v4 Rules (on top of v3.1)

| Rule | Logic | Rationale |
|------|-------|-----------|
| **Role Cap** | If `previous_role` (must_have) = `partially` -> candidate CANNOT be MATCH, capped to PARTIAL_MATCH | When the candidate's role doesn't fully match the requirement, even high scores on other criteria shouldn't override this. Olya consistently rates these as PARTIAL. |
| **Score Floor** | If total score < 70% -> candidate CANNOT be MATCH, capped to PARTIAL_MATCH | 65-69% is borderline territory. Olya treats these as PARTIAL, not MATCH. |

### 10.4 v4 Results

| Version | Agreement with Olya | Fixed | Broken |
|---------|-------------------|-------|--------|
| v3.1 | 28/37 = 75.7% | baseline | baseline |
| **v4** | **32/37 = 86.5%** | **+4** | **0** |

**Fixed candidates (4):**
1. Oumaima Hajjouji (Damac): MATCH -> PARTIAL_MATCH (Role Cap)
2. Ahmed Eldesouky (Damac): MATCH -> PARTIAL_MATCH (Role Cap)
3. Syed Huzaifa Shahid (Astra Tech): MATCH -> PARTIAL_MATCH (Score Floor, 69.7%)
4. Anil Paul (Bazaar): MATCH -> PARTIAL_MATCH (Role Cap)

**Remaining disagreements (5):**
1. Natia Darsavelidze — AI marked role=true, but Olya says tasks were administrative (assessment quality)
2. Ali Mirza — "hasn't done recruitment in 5-6 years" (recency not captured in criteria)
3. Nikos Kritselis — "overqualified" (concept not in criteria system)
4. Gowrishankar T S — resp=partially at 72.2%, but tightening conflicts with Ethisam (same score, Olya=MATCH)
5. Rayan T. — 2 false MH, tightening PARTIAL threshold breaks other agreements

### 10.5 Key Insight

3 of 5 remaining disagreements are **AI assessment quality issues** — the LLM that generates per-criterion fit values is too generous. Fixing these requires better assessment prompts (recency awareness, overqualification detection, deeper role analysis), not scoring formula changes.

### 10.6 v4 Implementation

```python
def calc_v4_score(assessment):
    fit_values = {'true': 1.0, 'partially': 0.5, 'false': 0.0}

    resp_items = [a for a in assessment if a['segment'] == 'responsibilities']
    role_items = [a for a in assessment if a['segment'] == 'previous_role']
    other_items = [a for a in assessment if a['segment'] not in ('responsibilities', 'previous_role')]

    base_weighted, base_max = 0, 0
    false_mh, mh_true, mh_total = 0, 0, 0

    for item in other_items:
        w = {'must_have': 1.5, 'nice_to_have': 0.5}.get(item['requirement'], 1.0)
        val = fit_values.get(item['fit'], 0.0)
        base_weighted += val * w
        base_max += w
        if item['requirement'] == 'must_have':
            mh_total += 1
            if item['fit'] == 'true': mh_true += 1
            elif item['fit'] == 'false': false_mh += 1

    for item in role_items:
        val = fit_values.get(item['fit'], 0.0)
        base_weighted += val * 1.5
        base_max += 1.5
        if item['requirement'] == 'must_have':
            mh_total += 1
            if item['fit'] == 'true': mh_true += 1
            elif item['fit'] == 'false': false_mh += 1

    resp_weighted, resp_max = 0, 0
    resp_fit = None
    for item in resp_items:
        val = fit_values.get(item['fit'], 0.0)
        resp_weighted += val * 3.0  # v3.1: critical must-have weight
        resp_max += 3.0
        resp_fit = item['fit']
        mh_total += 1
        if item['fit'] == 'true': mh_true += 1
        elif item['fit'] == 'false': false_mh += 1

    total = base_weighted + resp_weighted
    maximum = base_max + resp_max
    score = (total / maximum * 100) if maximum > 0 else 0
    base_score = (base_weighted / base_max * 100) if base_max > 0 else 0
    mh_ratio = mh_true / mh_total if mh_total > 0 else 0

    # Base verdict (same as v3)
    verdict = 'NO_MATCH'
    if (score >= 65 and false_mh == 0) or \
       (score >= 75 and false_mh <= 1 and mh_ratio >= 0.7):
        verdict = 'MATCH'
    elif (score >= 45 and false_mh <= 2) or \
         (score >= 35 and false_mh == 0):
        verdict = 'PARTIAL_MATCH'
    if base_score < 35:
        verdict = 'NO_MATCH'

    # v4 Rule 1: Role Cap
    role_mh_partially = any(
        r['fit'] == 'partially'
        for r in role_items if r['requirement'] == 'must_have'
    )
    if role_mh_partially and verdict == 'MATCH':
        verdict = 'PARTIAL_MATCH'

    # v4 Rule 2: Score Floor
    if verdict == 'MATCH' and score < 70:
        verdict = 'PARTIAL_MATCH'

    return {
        'score': round(score, 1),
        'verdict': verdict,
        'false_mh': false_mh,
        'mh_ratio': round(mh_ratio, 2)
    }
```
