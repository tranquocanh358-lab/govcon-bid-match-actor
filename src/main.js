import { Actor } from 'apify';
import { parse } from 'csv-parse';
import { Readable } from 'node:stream';

const BULK_URL = 'https://s3.amazonaws.com/falextracts/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const profile = input.capabilityProfile ?? {};
const lookbackDays = Number(input.lookbackDays ?? 30);
const maxResults = Number(input.maxResults ?? 50);
const onlyOpen = input.onlyOpen !== false;
const minFitScore = Number(input.minFitScore ?? 35);

const now = new Date();
const from = new Date(now.getTime() - lookbackDays * 86400000);

const clean = (value, fallback = '') => {
    const text = String(value ?? '').trim();
    return text || fallback;
};

const first = (row, keys, fallback = '') => {
    for (const key of keys) {
        const value = clean(row[key]);
        if (value) return value;
    }
    return fallback;
};

const keywords = (profile.keywords ?? [])
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);

const naics = new Set((profile.naicsCodes ?? []).map((value) => String(value).trim()).filter(Boolean));
const setAsides = new Set((profile.setAsideTypes ?? []).map((value) => String(value).trim().toLowerCase()).filter(Boolean));
const states = new Set((profile.states ?? []).map((value) => String(value).trim().toUpperCase()).filter(Boolean));
const agencies = (profile.agencies ?? [])
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);

function parseDate(value) {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function normalizeNaics(value) {
    if (!value) return [];
    return String(value)
        .split(/[;,|]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalize(row) {
    const title = first(row, ['Title', 'title', 'NOTICE_TITLE']);
    if (!title) return null;

    const description = first(row, ['Description', 'description', 'DESCRIPTION']);
    const agency = first(row, ['Department/Ind.Agency', 'Department', 'Sub-Tier', 'Agency', 'agency']);
    const noticeId = first(row, ['NoticeId', 'NoticeID', 'noticeId', 'notice_id']);
    const solicitationNumber = first(row, ['Sol#', 'SolicitationNumber', 'solicitationNumber', 'SOL#']);
    const noticeType = first(row, ['Type', 'NoticeType', 'BaseType', 'type']);
    const setAside = first(row, ['SetASide', 'SetAside', 'SetASideCode', 'typeOfSetAside']);
    const naicsCodes = normalizeNaics(first(row, ['NaicsCode', 'NAICSCode', 'naicsCode']));
    const postedDate = first(row, ['PostedDate', 'postedDate', 'PublishedDate']);
    const responseDeadline = first(row, ['ResponseDeadLine', 'ResponseDeadline', 'responseDeadline', 'ArchiveDate']);
    const state = first(row, ['PopState', 'PlaceOfPerformanceState', 'State', 'state']).toUpperCase();
    const samUrl = first(row, ['Link', 'URL', 'UiLink', 'AdditionalInfoLink'], 'https://sam.gov/opportunities');

    return {
        title,
        description,
        agency,
        noticeId,
        solicitationNumber,
        noticeType,
        setAside,
        naicsCodes,
        postedDate,
        responseDeadline,
        state,
        samUrl,
    };
}

function scoreOpportunity(opportunity) {
    let score = 0;
    const reasons = [];
    const risks = [];

    const haystack = `${opportunity.title} ${opportunity.description}`.toLowerCase();

    if (keywords.length) {
        const hits = keywords.filter((keyword) => haystack.includes(keyword));
        score += Math.min(35, hits.length * 12);
        if (hits.length) reasons.push(`Keyword match: ${hits.join(', ')}`);
    }

    if (naics.size && opportunity.naicsCodes.length) {
        const exact = opportunity.naicsCodes.filter((code) => naics.has(code));
        if (exact.length) {
            score += 30;
            reasons.push(`Exact NAICS match: ${exact.join(', ')}`);
        } else {
            const related = opportunity.naicsCodes.filter((code) =>
                [...naics].some((wanted) => code.startsWith(wanted) || wanted.startsWith(code))
            );
            if (related.length) {
                score += 18;
                reasons.push('Related NAICS match');
            }
        }
    }

    if (setAsides.size) {
        const value = opportunity.setAside.toLowerCase();
        const matched = [...setAsides].filter((item) => value.includes(item));
        if (matched.length) {
            score += 15;
            reasons.push(`Set-aside preference match: ${matched.join(', ')}`);
        } else if (value) {
            risks.push('Set-aside does not match the requested profile');
        }
    }

    if (states.size) {
        if (opportunity.state && states.has(opportunity.state)) {
            score += 10;
            reasons.push(`Place-of-performance state match: ${opportunity.state}`);
        } else if (opportunity.state) {
            risks.push(`Place of performance outside requested states: ${opportunity.state}`);
        }
    }

    if (agencies.length) {
        const agencyText = opportunity.agency.toLowerCase();
        const matched = agencies.filter((agency) => agencyText.includes(agency));
        if (matched.length) {
            score += 10;
            reasons.push(`Agency preference match: ${matched.join(', ')}`);
        }
    }

    const deadline = parseDate(opportunity.responseDeadline);
    let daysToDeadline = null;

    if (!deadline) {
        risks.push('No parseable response deadline');
    } else {
        daysToDeadline = (deadline.getTime() - now.getTime()) / 86400000;

        if (daysToDeadline < 0) {
            risks.push('Response deadline has passed');
        } else if (daysToDeadline <= 3) {
            score += 5;
            risks.push('Response deadline is very close');
        } else if (daysToDeadline <= 14) {
            reasons.push('Active near-term bid window');
        }
    }

    const posted = parseDate(opportunity.postedDate);
    if (posted && posted < from) return null;

    if (onlyOpen && deadline && deadline < now) return null;

    score = Math.max(0, Math.min(100, score));

    const decision =
        score >= 70 ? 'review-first' :
        score >= 45 ? 'possible-fit' :
        'low-fit';

    if (score < minFitScore) return null;

    return {
        kind: 'opportunity',
        fitScore: score,
        decision,
        title: opportunity.title,
        noticeId: opportunity.noticeId,
        solicitationNumber: opportunity.solicitationNumber,
        noticeType: opportunity.noticeType,
        naicsCodes: opportunity.naicsCodes,
        setAside: opportunity.setAside,
        agency: opportunity.agency,
        state: opportunity.state,
        postedDate: opportunity.postedDate,
        responseDeadline: opportunity.responseDeadline,
        daysToDeadline,
        fitReasons: reasons,
        riskFlags: risks,
        samUrl: opportunity.samUrl,
        source: 'SAM.gov public Contract Opportunities bulk CSV',
    };
}

const response = await fetch(BULK_URL, {
    headers: {
        Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8',
        'User-Agent': 'GovCon-Bid-Match-Apify-Actor/0.2',
    },
});

if (!response.ok || !response.body) {
    throw new Error(`SAM.gov bulk extract download failed: HTTP ${response.status}`);
}

const parser = Readable
    .fromWeb(response.body)
    .pipe(parse({
        columns: true,
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        trim: true,
    }));

const top = [];
let scanned = 0;
let active = 0;
let matched = 0;

for await (const row of parser) {
    scanned += 1;

    const activeValue = clean(row.Active ?? row.active).toLowerCase();
    if (activeValue && !['yes', 'true', '1'].includes(activeValue)) continue;

    active += 1;

    const opportunity = normalize(row);
    if (!opportunity) continue;

    const result = scoreOpportunity(opportunity);
    if (!result) continue;

    matched += 1;
    top.push(result);
    top.sort((a, b) => b.fitScore - a.fitScore || (a.daysToDeadline ?? 9999) - (b.daysToDeadline ?? 9999));

    if (top.length > maxResults) top.pop();
}

for (const result of top) {
    await Actor.pushData(result);
}

await Actor.setValue('OUTPUT', {
    source: BULK_URL,
    scannedRows: scanned,
    activeRows: active,
    matchedRows: matched,
    returnedRows: top.length,
    generatedAt: new Date().toISOString(),
    profile: {
        keywords,
        naicsCodes: [...naics],
        setAsideTypes: [...setAsides],
        states: [...states],
        agencies,
    },
});

await Actor.exit();
