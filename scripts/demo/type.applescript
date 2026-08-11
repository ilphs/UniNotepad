-- 파일 내용을 한 글자씩 사람 속도로 타이핑한다.
--   osascript type.applescript <파일경로> <글자당 지연(초)> <줄바꿈 뒤 추가 지연(초)>
--
-- 왜 한 글자씩인가: keystroke로 문자열을 통째로 보내면 순간 삽입돼 "타이핑하는
-- 영상"이 되지 않는다. 지연을 넣어 육안 속도를 만든다.
--
-- 주의 (에디터 동작과의 상호작용, src/editor.ts:173-175 확인 결과):
--   * closeBrackets 활성 — "[" 는 "[]"로 자동 페어링되지만, 이어서 닫는 문자를
--     치면 skip-over 되므로 소스를 그대로 쳐도 결과가 맞는다. 원고에 "[", "("는
--     반드시 짝을 이뤄 쓸 것.
--   * defaultKeymap의 Enter = insertNewlineAndIndent. 마크다운 본문은 들여쓰기
--     규칙이 없어 항상 0열에서 시작하지만, ```mermaid 펜스 안에서는 들여쓰기가
--     붙을 수 있다. mermaid는 선행 공백을 허용하므로 렌더에는 영향이 없다.
--   * 줄바꿈은 반드시 **Shift+Return** 으로 보낸다. markdown()은 addKeymap 기본값이
--     true여서 Prec.high로 Enter -> insertNewlineContinueMarkup 을 심는다
--     (node_modules/@codemirror/lang-markdown/dist/index.js:396-422). editor.ts의
--     keymap 배열에는 안 보이지만 실제로는 defaultKeymap을 이긴다. 그냥 Return을
--     쓰면 "- [x] ..." 다음 줄에 "- [ ] " 가 자동 삽입되고, 원고의 "- [ ]" 가 그 뒤에
--     또 찍혀 "- [ ] - [x] ..." 가 된다(1차 촬영에서 실제로 이렇게 깨졌다).
--     markdownKeymap은 "Enter"만 바인딩하므로 Shift+Return은 defaultKeymap의
--     insertNewlineAndIndent로 빠져 원고를 글자 그대로 입력한다.

on run argv
	set filePath to item 1 of argv
	set charDelay to (item 2 of argv) as real
	set lineDelay to (item 3 of argv) as real

	set txt to (read POSIX file filePath as «class utf8»)

	tell application "System Events"
		repeat with i from 1 to (count of characters of txt)
			set c to character i of txt
			if c is linefeed or c is return then
				key code 36 using shift down -- Shift+Return: 리스트 자동 이어쓰기 우회
				delay lineDelay
			else
				keystroke c
				delay charDelay
			end if
		end repeat
	end tell
end run
