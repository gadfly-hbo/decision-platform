import type { DerivationKind, DerivationStep } from '../data'

const KIND_LABEL: Record<DerivationKind, string> = {
  detection: '检测',
  attribution: '归因',
  rule: '规则匹配',
  suggestion: '建议',
}

export function DerivationChain({ steps }: { steps: DerivationStep[] }) {
  return (
    <ol className="derivation">
      {steps.map((step, index) => (
        <li key={index} className="derivation-step">
          <span className="step-no">{index + 1}</span>
          <span className={`step-kind kind-${step.kind}`}>{KIND_LABEL[step.kind]}</span>
          <span className="step-text">{step.text}</span>
        </li>
      ))}
    </ol>
  )
}
