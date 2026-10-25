"""Explicit, opt-in live model smoke test. Uses the configured proxy quota."""
import asyncio
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.platform.adapters import CometAssistant, assistant_failure_reason, ASSISTANT_FAILURE_MESSAGES

async def main():
    result = await CometAssistant().answer([{'role':'user','content':
        'Хочу купить оборудование для кофейни. Составь два вопроса, чтобы сравнить кредит и лизинг.'}], {})
    assert result['mode'] == 'llm' and result['questions']
    print('OK: provider=comet; model=' + result['model'] + '; generated_questions=' + str(len(result['questions'])))

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as error:
        reason = assistant_failure_reason(error)
        print('FAILED: reason=' + reason + '; ' + ASSISTANT_FAILURE_MESSAGES[reason], file=sys.stderr)
        sys.exit(1)
