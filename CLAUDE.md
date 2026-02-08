# Projekt-Regeln für Claude

## WICHTIG: Dokumentation vor Aktion

**Bei Problemen oder neuen Integrationen IMMER:**

1. **Zuerst recherchieren** - Offizielle Dokumentation lesen bevor irgendwelche Aktionen durchgeführt werden
2. **Anforderungen verstehen** - Alle benötigten Berechtigungen, Konfigurationen und Voraussetzungen VORHER identifizieren
3. **Plan erstellen** - Klare Schritte definieren bevor geklickt wird
4. **Verifizierte Lösungen** - Nur Lösungen implementieren die durch Dokumentation bestätigt sind
5. **Kein Raten** - Niemals blind herumprobieren oder klicken ohne zu wissen was benötigt wird

## API Integrationen

### Meta Ad Library API
- **Voraussetzung:** Identitätsverifizierung des Facebook-Accounts (facebook.com/ID)
- **Token-Typ:** User Access Token (NICHT nur System User Token)
- **Keine spezielle Permission nötig** - ads_read ist NICHT erforderlich für Ad Library
- **Einschränkung:** Funktioniert nur für EU, Brasilien, oder politische Ads

### ScrapingBee API
- **Zweck:** Headless Browser Fallback für Full URL Extraction
- **API Key:** Als Supabase Secret konfigurieren: `npx supabase secrets set SCRAPINGBEE_API_KEY=xxx`
- **Kosten:** ~50-100€/Monat für 100K Requests
- **Nutzung:** Nur als Fallback wenn HTML-Parsing fehlschlägt (spart Credits)

### Supabase Edge Functions
- Secrets werden über `npx supabase secrets set KEY=value` gesetzt
- Functions deployen mit `npx supabase functions deploy <name> --no-verify-jwt`
- **Neue Secrets für Teil 2:** `SCRAPINGBEE_API_KEY`

## KRITISCHE REGEL: Drittseiten-Verifizierung

**Eine Drittseite (Third-Party Page) darf NUR gelistet werden, wenn die URL-Chain verifiziert ist.**

Der Workflow MUSS so ablaufen:
1. Brand finden → Brand-Domain ermitteln (z.B. glow25.de)
2. Keywords aus Brand-Ads generieren → weitere Ads suchen
3. Für jeden gefundenen Advertiser → Domain extrahieren
4. **Domain verifizieren** (Step 6): URL aufrufen, Redirects folgen, CTA klicken, Shopify-Vendor prüfen
5. **NUR wenn die URL-Chain zur Brand-Domain führt** → als Match listen

**NIEMALS:**
- Pages listen nur weil sie in Brand-Search UND Keyword-Search vorkommen
- Pages listen ohne URL-Verifizierung (kein `brand_search_match` ohne Step 6)
- Kompromisse eingehen bei der Verifizierung — lieber 80% finden als 100% mit Fehlern

**Ziel:** 80-90% Recall, aber 100% Precision. Was gelistet wird, ist verifiziert.
**Gilt für:** Shopify UND alle anderen Shop-Typen (WooCommerce, Shopware, Custom, etc.)

## Debugging-Workflow

1. Fehler analysieren und Error-Code recherchieren
2. Offizielle Dokumentation konsultieren
3. Community-Lösungen prüfen (GitHub Issues, Stack Overflow)
4. Lösung mit Dokumentation verifizieren
5. Erst dann implementieren
