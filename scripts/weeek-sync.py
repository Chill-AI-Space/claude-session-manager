# -*- coding: utf-8 -*-
"""
Автоматизация: при попадании сделки в "Частичная оплата получена" (Воронка продаж)
дублирует её в начало "Воронки найма" со всей информацией.
Запускается каждые 5 минут через Планировщик задач Windows.
"""
import json, urllib.request, os, time, sys, io

LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'weeek-sync.log')

# pythonw.exe has no console, redirect output to log file
if sys.stdout is None or not hasattr(sys.stdout, 'buffer'):
    sys.stdout = open(LOG_FILE, 'a', encoding='utf-8')
    sys.stderr = sys.stdout
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

TOKEN = '35c9d06e-c72b-4273-8f8c-0a99d0800b29'
BASE = 'https://api.weeek.net/public/v1'
HEADERS = {
    'Authorization': f'Bearer {TOKEN}',
    'Content-Type': 'application/json',
    'Accept': 'application/json'
}

# Статус "Частичная оплата получена" в Воронке продаж
SOURCE_STATUS_ID = '5SC5un4C0S41W722'
# Первый статус "Подходит к распределению" в Воронке найма
TARGET_STATUS_ID = 'BTQXedYMGh4uqnMw'

# Файл для хранения уже скопированных сделок
SYNCED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'weeek-synced-deals.json')


def api_get(path):
    req = urllib.request.Request(f'{BASE}/{path}', headers=HEADERS)
    return json.loads(urllib.request.urlopen(req).read())


def api_post(path, data):
    req = urllib.request.Request(
        f'{BASE}/{path}',
        data=json.dumps(data).encode(),
        headers=HEADERS,
        method='POST'
    )
    return json.loads(urllib.request.urlopen(req).read())


def api_put(path, data):
    req = urllib.request.Request(
        f'{BASE}/{path}',
        data=json.dumps(data).encode(),
        headers=HEADERS,
        method='PUT'
    )
    return json.loads(urllib.request.urlopen(req).read())


def load_synced():
    if os.path.exists(SYNCED_FILE):
        with open(SYNCED_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []


def save_synced(synced):
    with open(SYNCED_FILE, 'w', encoding='utf-8') as f:
        json.dump(synced, f, ensure_ascii=False, indent=2)


def sync():
    print(f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] Checking for new deals...')

    # Get deals in "Частичная оплата получена"
    data = api_get(f'crm/statuses/{SOURCE_STATUS_ID}/deals')
    if not data.get('success'):
        print('  Error fetching deals')
        return

    deals = data.get('deals', [])
    synced = load_synced()
    new_count = 0

    for deal in deals:
        deal_id = deal['id']
        if deal_id in synced:
            continue

        # Get full deal info
        full = api_get(f'crm/deals/{deal_id}')
        if not full.get('success'):
            continue
        deal_data = full['deal']

        # Create copy in Воронка найма
        new_deal = {
            'title': deal_data['title'],
            'amount': deal_data.get('amount', 0),
            'description': deal_data.get('description', ''),
        }

        result = api_post(f'crm/statuses/{TARGET_STATUS_ID}/deals', new_deal)
        if not result.get('success'):
            print(f'  Error creating deal: {deal_data["title"]}')
            continue

        new_deal_id = result['deal']['id']

        # Attach contacts (API returns IDs as strings)
        for contact_id in deal_data.get('contacts', []):
            try:
                cid = contact_id if isinstance(contact_id, str) else contact_id.get('id', contact_id)
                api_post(f'crm/deals/{new_deal_id}/contacts', {'contactId': cid})
            except:
                pass
            time.sleep(0.2)

        # Attach organizations
        for org_id in deal_data.get('organizations', []):
            try:
                oid = org_id if isinstance(org_id, str) else org_id.get('id', org_id)
                api_post(f'crm/deals/{new_deal_id}/organizations', {'organizationId': oid})
            except:
                pass
            time.sleep(0.2)

        # Copy custom fields via deal update
        naim_fields = {
            'Откуда пришел': 'a14a2985-5491-4aee-8a54-82b4696167bd',
            'Вакансия для подбора': 'a14a29ad-25f7-4e34-b57a-527f8f864f0c',
            'Локация': 'a14fd6bf-1781-4dd2-912e-a212f370b63c',
        }
        custom_fields_update = []
        for cf in deal_data.get('customFields', []):
            if cf.get('value') and cf['name'] in naim_fields:
                custom_fields_update.append({
                    'id': naim_fields[cf['name']],
                    'value': cf['value']
                })
        if custom_fields_update:
            cf_dict = {item['id']: item['value'] for item in custom_fields_update}
            try:
                api_put(f'crm/deals/{new_deal_id}', {'customFields': cf_dict})
            except:
                pass
            time.sleep(0.2)

        synced.append(deal_id)
        new_count += 1
        print(f'  Copied: {deal_data["title"]} -> Воронка найма')
        time.sleep(0.3)

    save_synced(synced)

    if new_count == 0:
        print('  No new deals to sync')
    else:
        print(f'  Synced {new_count} new deals')


if __name__ == '__main__':
    # If run with --loop, run continuously every 5 minutes
    if '--loop' in sys.argv:
        print('Running in loop mode (every 5 minutes). Press Ctrl+C to stop.')
        while True:
            try:
                sync()
            except Exception as e:
                print(f'  Error: {e}')
            time.sleep(300)
    else:
        sync()
