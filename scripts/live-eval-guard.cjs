/* 실제 모델 호출은 명시적으로 켠 평가에서만 허용한다. --help는 켠 경우에도 실행하지 않는다. */
module.exports = function liveEvalGuard(script) {
  if (process.env.CODE_AGENT_LIVE_EVAL === '1' && !process.argv.includes('--help') && !process.argv.includes('-h')) return;
  console.log(`선택 실행: ${script} [인자]\n실제 모델 호출에 비용이 들 수 있습니다. 실행하려면 CODE_AGENT_LIVE_EVAL=1을 설정하세요.\n사용법과 인자는 해당 스크립트 머리말과 doc/process-flow.md §9를 확인하세요.`);
  process.exit(0);
};
