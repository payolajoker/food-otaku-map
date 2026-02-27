# Sick — 지도 페이지

rawdata.kmz(구글 맵스)에서 추출한 데이터를 단일 페이지 지도 페이지로 변환한 결과입니다.

## 실행

```powershell
cd web
python -m http.server 8000
```

브라우저에서 `http://localhost:8000` 접속.

## 데이터 갱신(추가 반영)

```powershell
.\scripts\build-places-from-kmz.ps1 -InputPath .\rawdata.kmz -OutputPath .\web\data\places.json
```

KMZ를 매번 로딩하지 않고, 위 스크립트로 변환된 `places.json`만 페이지가 사용합니다.

## 데이터 구조

- `web/data/places.json` (카테고리/이름/설명/좌표/유튜브 링크/타임스탬프)

