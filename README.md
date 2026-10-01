# GovCon Bid Match & Qualification

An Apify Actor that matches public U.S. federal contract opportunities to a contractor capability profile and returns ranked, structured bid/no-bid signals.

## Why this MVP is keyless

SAM.gov publishes a public Contract Opportunities bulk CSV extract. The public extract can be consumed without a SAM.gov API key, so users do not need to create or paste a government API key just to run this Actor.

Source:
https://s3.amazonaws.com/falextracts/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv

## What it does

1. Downloads the public SAM.gov Contract Opportunities bulk feed.
2. Reads active opportunity records.
3. Filters by posting date and response deadline.
4. Scores each opportunity against:
   - keywords
   - NAICS codes
   - set-aside preferences
   - states / place of performance
   - preferred agencies
   - deadline urgency
5. Returns the highest-scoring opportunities with reasons and risk flags.

## Example capability profile

- NAICS: 541511, 541512, 541519
- keywords: software, cloud, cybersecurity
- states: TX, VA
- set-asides: SBA, 8A

## Important limitation

This is a screening and prioritization tool, not legal, contracting, or bid/no-bid advice. Users should verify the source notice and solicitation documents on SAM.gov before acting.

## Data source

SAM.gov is the authoritative U.S. government source for Contract Opportunities. The Actor uses the public bulk extract rather than scraping the SAM.gov website.
